import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  readBoundedStdin, parseHookInput, findAgentPid, acquireLock, readStateFile,
  stateFileName, applySignals, runHook,
} from '../src/hooks/bridge.js';
import { SIGNAL } from '../src/core/lifecycle.js';
import { STATUS } from '../src/core/status.js';
import { readAllSessionsFromDir } from '../src/adapters/opencode/adapter.js';

function tmpStateDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-bridge-'));
  return { root, dir: path.join(root, 'letitcook', 'sessions') };
}

async function testBoundedStdin() {
  assert.strictEqual(await readBoundedStdin(Readable.from([Buffer.from('{"a":'), Buffer.from('1}')])), '{"a":1}');
  assert.strictEqual(await readBoundedStdin(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 15), null, 'oversized input is dropped');
  assert.deepStrictEqual(parseHookInput('{"a":1}'), { a: 1 });
  for (const bad of ['', 'not json', '[1]', 'null', '42', null]) {
    assert.strictEqual(parseHookInput(bad), null, `rejects ${bad}`);
  }
}

function testFindAgentPid() {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-proc-'));
  const add = (pid, comm, ppid) => {
    fs.mkdirSync(path.join(proc, String(pid)));
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0 -1\n`);
  };
  try {
    add(100, 'claude', 1);
    add(200, 'sh', 100);
    add(300, 'bash', 200);
    add(400, 'my (odd) agent', 1);
    assert.strictEqual(findAgentPid({ procRoot: proc, startPid: 300 }), 100, 'skips shells up to the agent');
    assert.strictEqual(findAgentPid({ procRoot: proc, startPid: 100 }), 100, 'direct parent');
    assert.strictEqual(findAgentPid({ procRoot: proc, startPid: 400 }), 400, 'comm with spaces and parentheses');
    assert.strictEqual(findAgentPid({ procRoot: proc, startPid: 999 }), null, 'unknown process');
    assert.strictEqual(findAgentPid({ procRoot: path.join(proc, 'missing'), startPid: 300 }), null, 'no /proc');
    assert.strictEqual(findAgentPid({ procRoot: proc, startPid: 300, maxDepth: 1 }), null, 'bounded walk');
  } finally {
    fs.rmSync(proc, { recursive: true, force: true });
  }
}

function testLocking() {
  const { root, dir } = tmpStateDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, '.x.lock');
    const release = acquireLock(lock);
    assert.ok(release, 'first holder gets the lock');
    const started = Date.now();
    assert.strictEqual(acquireLock(lock, { timeoutMs: 50 }), null, 'second holder times out');
    assert.ok(Date.now() - started < 1000, 'bounded wait');
    release();
    assert.ok(!fs.existsSync(lock), 'released');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 5 * 1000);
    fs.utimesSync(lock, old, old);
    const again = acquireLock(lock, { timeoutMs: 50 });
    assert.ok(again, 'a stale lock from a crashed hook is broken');
    again();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A hook that cannot take the lock (another hook holds it) leaves the file untouched:
// writing unlocked could replace that hook's waiting request.
function testContendedUpdateIsSkipped() {
  const { root, dir } = tmpStateDir();
  try {
    applySignals('claude', [{ type: SIGNAL.REQUEST_OPEN, sessionId: 's1', requestId: 'r1' }], { stateDir: dir, pid: null });
    const file = path.join(dir, stateFileName('claude', 's1'));
    const before = fs.readFileSync(file, 'utf8');
    const lock = path.join(dir, `.${stateFileName('claude', 's1')}.lock`);
    fs.writeFileSync(lock, '');
    const written = applySignals('claude', [{ type: SIGNAL.REQUEST_OPEN, sessionId: 's1', requestId: 'r2' }], { stateDir: dir, pid: null, lockTimeoutMs: 50 });
    assert.deepStrictEqual(written, [], 'no update without the lock');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'the file is untouched');
    assert.ok(fs.existsSync(lock), "another hook's lock is not removed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testReadStateFileSafety() {
  const { root, dir } = tmpStateDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'claude_s1.json');
    fs.writeFileSync(file, JSON.stringify({ session_id: 's1', agent: 'claude', status: 'cooking' }));
    assert.strictEqual(readStateFile(file, { sessionId: 's1', agent: 'claude' }).status, 'cooking');
    assert.strictEqual(readStateFile(file, { sessionId: 's1', agent: 'gemini' }), null, 'other agent');
    assert.strictEqual(readStateFile(file, { sessionId: 's2', agent: 'claude' }), null, 'other session');
    const target = path.join(root, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ session_id: 's3', agent: 'claude', status: 'done' }));
    fs.symlinkSync(target, path.join(dir, 'claude_s3.json'));
    assert.strictEqual(readStateFile(path.join(dir, 'claude_s3.json'), { sessionId: 's3', agent: 'claude' }), null, 'symlinks are not followed');
    fs.writeFileSync(path.join(dir, 'claude_s4.json'), 'x'.repeat(300 * 1024));
    assert.strictEqual(readStateFile(path.join(dir, 'claude_s4.json'), { sessionId: 's4', agent: 'claude' }), null, 'oversized file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testApplySignalsWritesReadableState() {
  const { root, dir } = tmpStateDir();
  try {
    applySignals('claude', [{ type: SIGNAL.TURN_START, sessionId: 's1', cwd: '/w' }], { stateDir: dir, now: 1000, pid: process.pid });
    const file = path.join(dir, stateFileName('claude', 's1'));
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'session file is private');
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700, 'state directory is private');
    const [session] = readAllSessionsFromDir(dir, { now: 1000, isPidAlive: () => true });
    assert.strictEqual(session.status, STATUS.COOKING);
    assert.strictEqual(session.agent, 'claude');
    assert.strictEqual(session.pid, process.pid);

    applySignals('claude', [{ type: SIGNAL.TURN_COMPLETE, sessionId: 's1' }], { stateDir: dir, now: 2000, pid: process.pid });
    assert.strictEqual(readAllSessionsFromDir(dir, { now: 2000, isPidAlive: () => true })[0].status, STATUS.DONE);

    const before = fs.statSync(file).mtimeMs;
    const unchanged = applySignals('claude', [{ type: SIGNAL.ACTIVITY, sessionId: 's1' }], { stateDir: dir, now: 3000 });
    assert.deepStrictEqual(unchanged, [], 'late activity after Done writes nothing');
    assert.strictEqual(fs.statSync(file).mtimeMs, before);

    applySignals('claude', [{ type: SIGNAL.SESSION_END, sessionId: 's1' }], { stateDir: dir, now: 4000 });
    assert.ok(!fs.existsSync(file), 'session end removes the file');
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'no temporary or lock files are left');

    assert.deepStrictEqual(applySignals('claude', [{ type: SIGNAL.ACTIVITY, sessionId: '../x' }], { stateDir: dir }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testUntrustedStateDirIsRefused() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-bridge-untrusted-'));
  try {
    const target = path.join(root, 'shared');
    fs.mkdirSync(target, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    const link = path.join(root, 'sessions');
    fs.symlinkSync(target, link);
    assert.throws(() => applySignals('claude', [{ type: SIGNAL.TURN_START, sessionId: 's1' }], { stateDir: link }),
      /other users can access/);
    assert.deepStrictEqual(fs.readdirSync(target), [], 'nothing written through the link');
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o755, 'link target is never chmod-ed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRunHookNeverThrows() {
  const { root, dir } = tmpStateDir();
  try {
    const adapter = { id: 'fake', toSignals: input => [{ type: SIGNAL.TURN_START, sessionId: input.session_id }] };
    const stdin = text => Readable.from([Buffer.from(text)]);
    assert.deepStrictEqual(await runHook(adapter, { stdin: stdin('garbage'), stateDir: dir, pid: null }), []);
    assert.deepStrictEqual(await runHook({ id: 'fake', toSignals: () => { throw new Error('boom'); } }, { stdin: stdin('{}'), stateDir: dir, pid: null }), []);
    const written = await runHook(adapter, { stdin: stdin('{"session_id":"abc"}'), stateDir: dir, pid: null });
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].status, STATUS.COOKING);
    fs.writeFileSync(path.join(root, 'file-not-dir'), '');
    assert.deepStrictEqual(await runHook(adapter, { stdin: stdin('{"session_id":"abc"}'), stateDir: path.join(root, 'file-not-dir', 'x'), pid: null }).catch(() => 'threw'), [],
      'an unusable state directory is swallowed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Hook processes for parallel tool calls run at the same time. Without the lock their
// read-modify-write cycles would lose requests.
async function testConcurrentHooksKeepEveryRequest() {
  const { root, dir } = tmpStateDir();
  try {
    const bridgeUrl = pathToFileURL(path.resolve('src/hooks/bridge.js')).href;
    const lifecycleUrl = pathToFileURL(path.resolve('src/core/lifecycle.js')).href;
    applySignals('fake', [{ type: SIGNAL.TURN_START, sessionId: 's1' }], { stateDir: dir, pid: null });
    const script = (i) => `
      const { applySignals } = await import(${JSON.stringify(bridgeUrl)});
      const { SIGNAL } = await import(${JSON.stringify(lifecycleUrl)});
      applySignals('fake', [{ type: SIGNAL.REQUEST_OPEN, sessionId: 's1', requestId: 'r${i}' }], { stateDir: ${JSON.stringify(dir)}, pid: null });
    `;
    const runs = Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script(i)], { stdio: 'inherit' });
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
    }));
    await Promise.all(runs);
    const state = JSON.parse(fs.readFileSync(path.join(dir, stateFileName('fake', 's1')), 'utf8'));
    assert.deepStrictEqual(Object.keys(state.lifecycle.pending).sort(), Array.from({ length: 8 }, (_, i) => `r${i}`).sort(),
      'every concurrent request is kept');
    assert.strictEqual(state.status, STATUS.YOUR_TURN);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function run() {
  await testBoundedStdin();
  testFindAgentPid();
  testLocking();
  testContendedUpdateIsSkipped();
  testReadStateFileSafety();
  testApplySignalsWritesReadableState();
  testUntrustedStateDirIsRefused();
  await testRunHookNeverThrows();
  await testConcurrentHooksKeepEveryRequest();
  console.log('All LetItCook hook bridge tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
