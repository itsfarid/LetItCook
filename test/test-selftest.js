import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { parseModel, isApprovedRequest, summarizeReason, SELFTEST_COMMAND, runSelftest } from '../src/selftest.js';

const FAKE_OPENCODE = path.resolve('test/fixtures/fake-opencode.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Isolated environment: fake opencode wrapper, private TMPDIR and XDG_STATE_HOME, a
// pre-existing user session that must survive, and a decoy "opencode" process that
// must never be signalled.
function makeSandbox(name, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `letitcook-selftest-${name}-`));
  const tmp = path.join(root, 'tmp');
  const sessions = path.join(root, 'state', 'letitcook', 'sessions');
  fs.mkdirSync(tmp);
  fs.mkdirSync(sessions, { recursive: true });
  const userSession = path.join(sessions, 'ses_existing_user.json');
  fs.writeFileSync(userSession, JSON.stringify({ session_id: 'ses_existing_user', agent: 'opencode', status: 'your_turn', updated_at: Date.now() }));
  const bin = path.join(root, 'opencode');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_OPENCODE}" "$@"\n`, { mode: 0o755 });
  const logFile = path.join(root, 'fake.log');
  const env = {
    ...process.env, OPENCODE_BIN: bin, TMPDIR: tmp, XDG_STATE_HOME: path.join(root, 'state'),
    LETITCOOK_STATE_DIR: '', FAKE_OPENCODE_MODE: mode, FAKE_OPENCODE_LOG: logFile,
  };
  const decoy = spawn(process.execPath, [FAKE_OPENCODE, 'serve'], { env: { ...env, FAKE_OPENCODE_MODE: 'idle', FAKE_OPENCODE_LOG: '' }, stdio: 'ignore' });
  const events = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  return {
    env, tmp, sessions, events,
    serverPid: () => events().find(e => e.event === 'start')?.pid,
    // Everything the run created is gone; everything it did not create is untouched.
    assertCleaned(label) {
      const pid = this.serverPid();
      assert.ok(pid, `${label}: fake server started`);
      assert.strictEqual(isAlive(pid), false, `${label}: no orphaned OpenCode server`);
      assert.deepStrictEqual(fs.readdirSync(tmp), [], `${label}: temporary project removed`);
      assert.deepStrictEqual(fs.readdirSync(sessions), ['ses_existing_user.json'], `${label}: test session state removed, user session kept`);
      assert.strictEqual(JSON.parse(fs.readFileSync(userSession, 'utf8')).status, 'your_turn', `${label}: user session untouched`);
      assert.strictEqual(isAlive(decoy.pid), true, `${label}: pre-existing OpenCode process not killed`);
    },
    dispose() {
      const pid = this.serverPid();
      if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
      decoy.kill('SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function withEnv(env, fn) {
  const keys = ['OPENCODE_BIN', 'TMPDIR', 'XDG_STATE_HOME', 'LETITCOOK_STATE_DIR', 'FAKE_OPENCODE_MODE', 'FAKE_OPENCODE_LOG'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, Object.fromEntries(keys.map(k => [k, env[k]])));
  try {
    return await fn();
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

async function runInProcess(sandbox, timeouts = {}) {
  const lines = [];
  const results = await withEnv(sandbox.env, () => runSelftest({ model: 'p/m', ask: false, log: line => lines.push(line), timeouts }));
  return { results, output: lines.join('\n') };
}

// Runs the real CLI; `trigger` decides when to interrupt it.
async function runCli(sandbox, { args = ['--no-ask'], pty = false, trigger } = {}) {
  const command = [process.execPath, 'src/selftest.js', '--model', 'p/m', ...args];
  const child = pty
    ? spawn('script', ['-qfec', command.map(a => `'${a}'`).join(' '), '/dev/null'], { env: sandbox.env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(command[0], command.slice(1), { env: sandbox.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  const startedAt = Date.now();
  await trigger(child, () => output);
  let timer;
  const exit = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 20000); })]);
  clearTimeout(timer);
  if (!exit) child.kill('SIGKILL');
  return { exit, output, ms: Date.now() - startedAt };
}

async function waitUntil(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  throw new Error('condition not reached in time');
}

function testParseModel() {
  assert.deepStrictEqual(parseModel('deepseek/deepseek-v4-pro'), { providerID: 'deepseek', modelID: 'deepseek-v4-pro' });
  assert.deepStrictEqual(parseModel('openrouter/anthropic/claude'), { providerID: 'openrouter', modelID: 'anthropic/claude' }, 'only the first slash splits');
  for (const bad of ['', 'noslash', '/model', 'provider/', null, undefined, 42]) {
    assert.strictEqual(parseModel(bad), null, `rejects ${String(bad)}`);
  }
}

function testOnlyTheSelftestCommandIsApproved() {
  assert.strictEqual(isApprovedRequest({ permission: 'bash', patterns: [SELFTEST_COMMAND] }), true);
  assert.strictEqual(isApprovedRequest({ action: 'bash', resources: [SELFTEST_COMMAND] }), true, 'v2 shape');
  for (const request of [
    null,
    { permission: 'bash', patterns: ['rm -rf /'] },
    { permission: 'bash', patterns: [`${SELFTEST_COMMAND}; rm -rf ~`] },
    { permission: 'bash', patterns: [SELFTEST_COMMAND, 'curl example.com'] },
    { permission: 'edit', patterns: [SELFTEST_COMMAND] },
    { permission: 'bash', patterns: [] },
    { permission: 'bash' },
  ]) {
    assert.strictEqual(isApprovedRequest(request), false, `rejects ${JSON.stringify(request)}`);
  }
}

function testSummarizeReason() {
  assert.strictEqual(summarizeReason('error:Model not found\n    at getModel (/x.js:1)'), 'error:Model not found', 'stack trace dropped');
  assert.strictEqual(summarizeReason('a\u001b[31mb\u0007c'), 'a[31mbc', 'control characters removed');
  assert.strictEqual(summarizeReason('x'.repeat(200)).length, 160);
  assert.strictEqual(summarizeReason(undefined), '');
}

// Failure paths must report FAIL, exit 1 and leave no temporary project behind.
function testFailurePathsCleanUp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-selftest-test-'));
  try {
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(tmp);
    const earlyExit = path.join(root, 'opencode-exits');
    fs.writeFileSync(earlyExit, '#!/bin/sh\necho "boom"\nexit 3\n', { mode: 0o755 });

    for (const [bin, expected] of [
      [path.join(root, 'missing-opencode'), 'Could not start opencode'],
      [earlyExit, 'exited early'],
    ]) {
      const result = spawnSync(process.execPath, ['src/selftest.js', '--no-ask', '--model', 'p/m'], {
        encoding: 'utf8',
        env: { ...process.env, OPENCODE_BIN: bin, TMPDIR: tmp, XDG_STATE_HOME: path.join(root, 'state'), LETITCOOK_STATE_DIR: '' },
        timeout: 30000,
      });
      assert.strictEqual(result.status, 1, `${expected}: exits 1 (${result.stderr})`);
      assert.match(result.stdout, /Self-test \.+ FAIL/, `${expected}: reported as FAIL`);
      assert.ok(result.stdout.includes(expected), `${expected}: explains the failure`);
      assert.ok(result.stdout.includes('Cleaned up'), `${expected}: cleanup ran`);
      assert.deepStrictEqual(fs.readdirSync(tmp), [], `${expected}: temporary project removed`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testHelpAndBadArguments() {
  const help = spawnSync(process.execPath, ['src/selftest.js', '--help'], { encoding: 'utf8' });
  assert.strictEqual(help.status, 0);
  assert.ok(help.stdout.includes(SELFTEST_COMMAND), 'help names the only approved command');
  const bad = spawnSync(process.execPath, ['src/selftest.js', '--model', 'nope'], { encoding: 'utf8', env: { ...process.env, OPENCODE_BIN: '/nonexistent' } });
  assert.strictEqual(bad.status, 1);
  assert.ok(bad.stdout.includes('Invalid model'), 'invalid model is reported');
  const unknown = spawnSync(process.execPath, ['src/selftest.js', '--bogus'], { encoding: 'utf8' });
  assert.strictEqual(unknown.status, 2);
}

async function testSuccessPathCleansUp() {
  const sandbox = makeSandbox('success', 'success');
  try {
    const { results } = await runInProcess(sandbox);
    const outcomes = Object.fromEntries(results.map(r => [r.step, r.outcome]));
    assert.deepStrictEqual(outcomes, {
      'Cooking': 'PASS', 'Permission request': 'PASS', 'Your Turn notification': 'PASS', 'Your Turn popup': 'SKIP',
      'Approved -> Cooking': 'PASS', 'Done': 'PASS', 'Done notification': 'PASS', 'Done popup': 'SKIP',
    }, JSON.stringify(results));
    const requests = sandbox.events().filter(e => e.event === 'request');
    assert.ok(requests.some(e => e.url === '/permission/per_selftest/reply' && e.reply === 'once'), 'approved the exact request by id');
    assert.ok(requests.some(e => e.method === 'DELETE'), 'test session deleted');
    sandbox.assertCleaned('success');
  } finally {
    sandbox.dispose();
  }
}

async function testStartupTimeoutCleansUp() {
  const sandbox = makeSandbox('startup-timeout', 'slow-start');
  try {
    const { results } = await runInProcess(sandbox, { startup: 500, killGrace: 1000 });
    assert.deepStrictEqual(results.map(r => r.outcome), ['FAIL']);
    assert.match(results[0].detail, /did not start within/);
    sandbox.assertCleaned('startup timeout');
  } finally {
    sandbox.dispose();
  }
}

async function testRequestTimeoutCleansUp() {
  const sandbox = makeSandbox('request-timeout', 'hang-requests,ignore-sigterm');
  try {
    const started = Date.now();
    const { results } = await runInProcess(sandbox, { request: 500, cleanupRequests: 500, killGrace: 500 });
    assert.strictEqual(results.at(-1).outcome, 'FAIL', 'unanswered request fails the run');
    assert.match(results.at(-1).detail, /timeout/i);
    assert.ok(Date.now() - started < 10000, 'shutdown is bounded even when the server hangs and ignores SIGTERM');
    sandbox.assertCleaned('request timeout');
  } finally {
    sandbox.dispose();
  }
}

async function testSignalsCleanUp() {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const sandbox = makeSandbox(signal.toLowerCase(), 'hang-after-ask');
    try {
      const run = await runCli(sandbox, {
        trigger: async (child) => {
          await waitUntil(() => sandbox.events().some(e => e.event === 'asked'));
          fs.appendFileSync(sandbox.env.FAKE_OPENCODE_LOG, `${JSON.stringify({ event: 'signal' })}\n`);
          child.kill(signal);
        },
      });
      assert.deepStrictEqual(run.exit, { code, signal: null }, `${signal}: exits ${code} after cleanup (${run.output})`);
      assert.ok(run.output.includes(`Interrupted (${signal})`), `${signal}: reports the interruption`);
      assert.ok(run.output.includes('Cleaned up'), `${signal}: cleanup ran`);
      const requests = sandbox.events().filter(e => e.event === 'request');
      assert.ok(requests.some(e => e.reply === 'reject'), `${signal}: pending permission rejected`);
      assert.ok(requests.some(e => e.method === 'DELETE'), `${signal}: test session deleted`);
      // The workflow stops at the interruption: no approval, and nothing after cleanup.
      const events = sandbox.events();
      const afterSignal = events.slice(events.findIndex(e => e.event === 'signal'));
      assert.ok(!afterSignal.some(e => e.reply === 'once'), `${signal}: no approval after the interruption`);
      const afterDelete = afterSignal.slice(afterSignal.findIndex(e => e.method === 'DELETE') + 1);
      assert.deepStrictEqual(afterDelete.filter(e => e.event === 'request'), [], `${signal}: no request after cleanup deleted the session`);
      sandbox.assertCleaned(signal);
    } finally {
      sandbox.dispose();
    }
  }
}

// A server that has already exited is never signalled: its process-group ID may have been
// reused by an unrelated process. Every process.kill call of the run is recorded.
async function testExitedServerIsNotSignalled() {
  const sandbox = makeSandbox('exited-server', 'exit-after-ask');
  const originalKill = process.kill;
  const groupSignals = [];
  process.kill = (pid, signal) => {
    if (pid < 0) groupSignals.push({ pid, signal });
    return originalKill.call(process, pid, signal);
  };
  try {
    const { results } = await runInProcess(sandbox, { notify: 300, request: 1000, killGrace: 500 });
    assert.ok(sandbox.events().some(e => e.event === 'exiting'), 'fake server exited on its own');
    assert.strictEqual(results.at(-1).outcome, 'FAIL', 'losing the server fails the run');
    assert.deepStrictEqual(groupSignals, [], 'no process-group signal after the server exited');
    sandbox.assertCleaned('exited server');
  } finally {
    process.kill = originalKill;
    sandbox.dispose();
  }
}

async function testSignalDuringStartupCleansUp() {
  const sandbox = makeSandbox('sigint-startup', 'slow-start');
  try {
    const run = await runCli(sandbox, {
      trigger: async (child) => {
        await waitUntil(() => sandbox.serverPid());
        child.kill('SIGINT');
      },
    });
    assert.deepStrictEqual(run.exit, { code: 130, signal: null }, run.output);
    sandbox.assertCleaned('SIGINT during startup');
  } finally {
    sandbox.dispose();
  }
}

async function testSignalWithUnresponsiveServerIsBounded() {
  const sandbox = makeSandbox('sigint-hung', 'hang-requests,ignore-sigterm');
  try {
    let signalledAt = 0;
    const run = await runCli(sandbox, {
      trigger: async (child) => {
        await waitUntil(() => sandbox.events().some(e => e.event === 'hung'));
        signalledAt = Date.now();
        child.kill('SIGINT');
      },
    });
    assert.deepStrictEqual(run.exit, { code: 130, signal: null }, run.output);
    const shutdownMs = run.ms - (signalledAt - (Date.now() - run.ms));
    assert.ok(shutdownMs < 12000, `shutdown bounded (${shutdownMs} ms)`);
    assert.ok(sandbox.events().some(e => e.event === 'sigterm-ignored'), 'server ignored SIGTERM and was killed');
    sandbox.assertCleaned('SIGINT with unresponsive server');
  } finally {
    sandbox.dispose();
  }
}

async function testSecondSignalForcesExit() {
  const sandbox = makeSandbox('double-sigint', 'hang-requests,ignore-sigterm');
  try {
    const run = await runCli(sandbox, {
      trigger: async (child, output) => {
        await waitUntil(() => sandbox.events().some(e => e.event === 'hung'));
        child.kill('SIGINT');
        await waitUntil(() => output().includes('Interrupted'));
        child.kill('SIGINT');
      },
    });
    assert.deepStrictEqual(run.exit, { code: 130, signal: null }, run.output);
    await waitUntil(() => !isAlive(sandbox.serverPid()), 3000);
    sandbox.assertCleaned('second SIGINT');
  } finally {
    sandbox.dispose();
  }
}

// Ctrl+C typed at the interactive popup question arrives through readline, not as a signal.
async function testCtrlCAtPopupPromptCleansUp() {
  if (spawnSync('script', ['--version']).status !== 0) {
    console.log('  SKIP Ctrl+C at prompt: util-linux `script` not available for a pseudo-terminal');
    return;
  }
  const sandbox = makeSandbox('ctrl-c-prompt', 'success');
  try {
    const run = await runCli(sandbox, {
      args: [],
      pty: true,
      trigger: async (child, output) => {
        await waitUntil(() => output().includes('[y/n]'), 15000);
        child.stdin.write('\x03');
      },
    });
    assert.deepStrictEqual(run.exit, { code: 130, signal: null }, run.output);
    assert.ok(run.output.includes('Interrupted (SIGINT)'), 'Ctrl+C at the prompt is an interruption, not a failed check');
    assert.ok(!run.output.includes('FAIL'), 'no check reported as failed');
    sandbox.assertCleaned('Ctrl+C at prompt');
  } finally {
    sandbox.dispose();
  }
}

async function run() {
  testParseModel();
  testOnlyTheSelftestCommandIsApproved();
  testSummarizeReason();
  testHelpAndBadArguments();
  testFailurePathsCleanUp();
  await testSuccessPathCleansUp();
  await testStartupTimeoutCleansUp();
  await testRequestTimeoutCleansUp();
  await testSignalsCleanUp();
  await testExitedServerIsNotSignalled();
  await testSignalDuringStartupCleansUp();
  await testSignalWithUnresponsiveServerIsBounded();
  await testSecondSignalForcesExit();
  await testCtrlCAtPopupPromptCleansUp();
  console.log('All LetItCook self-test tool tests passed.');
}

await run();
