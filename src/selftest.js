// LetItCook end-to-end self-test for the OpenCode integration.
//
// Starts a private, password-protected `opencode serve` on 127.0.0.1 in a temporary
// project whose config asks before every bash command, sends one prompt and checks:
//
//   Cooking -> Your Turn (real permission request) -> GNOME notification
//           -> Cooking (approved) -> Done -> Done notification (if enabled)
//
// Only the exact harmless command `echo letitcook-selftest` is ever approved; any other
// request is rejected. The session, server and temporary project are removed afterwards.
//
// Usage:
//   node src/selftest.js [--model provider/model] [--no-ask]
//
// Env:
//   LETITCOOK_SELFTEST_MODEL  default model (provider/model)
//   OPENCODE_BIN              opencode executable (default: `opencode` on PATH)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline/promises';
import { getSessionDir } from './adapters/opencode/adapter.js';
import { isValidSessionId } from './core/fs-safe.js';
import { getCachePath } from './notify.js';

export const SELFTEST_COMMAND = 'echo letitcook-selftest';
const PROMPT = [
  'This is an automated LetItCook self-test.',
  `Use the bash tool exactly once to run this exact command: ${SELFTEST_COMMAND}`,
  'Do not run any other command or use any other tool.',
  'After the command finishes, reply with one short sentence and stop.',
].join('\n');

const POLL_MS = 100;
const DEFAULT_TIMEOUTS = Object.freeze({
  startup: 30 * 1000,
  request: 15 * 1000,
  agent: 3 * 60 * 1000,
  notify: 5 * 1000,
  // Bounded shutdown: session cleanup requests, then SIGTERM grace before SIGKILL.
  cleanupRequests: 3 * 1000,
  killGrace: 3 * 1000,
});
// Exit codes for an interrupted run, as a shell reports a process killed by the signal.
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Wait for `promise` at most `ms`, without leaving the timer armed afterwards.
function withinBudget(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })])
    .finally(() => clearTimeout(timer));
}

export function parseModel(value) {
  if (typeof value !== 'string') return null;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

// Only the exact self-test command may be approved; everything else is rejected. Besides
// the permission patterns, the full command OpenCode will run (`metadata.command`) must be
// exactly the self-test command whenever OpenCode provides it.
export function isApprovedRequest(request) {
  const patterns = request && (request.patterns || request.resources);
  const command = request?.metadata?.command;
  return Boolean(request) &&
    (request.permission || request.action) === 'bash' &&
    Array.isArray(patterns) && patterns.length === 1 && patterns[0].trim() === SELFTEST_COMMAND &&
    (command === undefined || (typeof command === 'string' && command.trim() === SELFTEST_COMMAND));
}

// First line of an agent-provided reason, without stack traces or control characters.
export function summarizeReason(reason, maxLen = 160) {
  const line = String(reason || '').split('\n')[0].replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

function parseArgs(argv) {
  const opts = { model: null, ask: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--no-ask') opts.ask = false;
    else if (arg === '--model') opts.model = argv[++i] ?? '';
    else if (arg.startsWith('--model=')) opts.model = arg.slice('--model='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

// The model OpenCode's TUI used most recently, so a bare `npm run selftest` matches it.
function recentOpenCodeModel() {
  const xdgState = process.env.XDG_STATE_HOME;
  const stateHome = xdgState && path.isAbsolute(xdgState) ? xdgState : path.join(os.homedir(), '.local', 'state');
  try {
    const recent = JSON.parse(fs.readFileSync(path.join(stateHome, 'opencode', 'model.json'), 'utf8')).recent;
    const first = Array.isArray(recent) ? recent[0] : null;
    if (first && typeof first.providerID === 'string' && typeof first.modelID === 'string') return first;
  } catch {}
  return null;
}

function resolveModel(opts) {
  const explicit = opts.model ?? process.env.LETITCOOK_SELFTEST_MODEL;
  if (explicit) {
    const model = parseModel(explicit);
    if (!model) throw new Error(`Invalid model "${explicit}", expected provider/model`);
    return { model, source: 'requested' };
  }
  const recent = recentOpenCodeModel();
  return recent ? { model: recent, source: 'your most recent OpenCode model' } : { model: null, source: 'OpenCode default' };
}

function resolveOpenCodeBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const installed = path.join(os.homedir(), '.opencode', 'bin', 'opencode');
  const onPath = (process.env.PATH || '').split(path.delimiter).some(dir => dir && fs.existsSync(path.join(dir, 'opencode')));
  return !onPath && fs.existsSync(installed) ? installed : 'opencode';
}

// Read-only view of the GNOME extension's notification cache; never follows symlinks.
function readNotifyCache(cachePath) {
  try {
    if (!fs.lstatSync(cachePath).isFile()) return null;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// `onSpawn` receives the child immediately, so an interruption during startup can stop it.
function startServer(bin, cwd, password, timeoutMs, onSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    onSpawn(child);
    let output = '';
    let started = false;
    const timer = setTimeout(() => fail(new Error(`opencode serve did not start within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    const fail = (error) => { clearTimeout(timer); reject(Object.assign(error, { child })); };
    child.on('error', error => fail(new Error(`Could not start opencode (${bin}): ${error.message}`)));
    child.on('exit', code => fail(new Error(`opencode serve exited early (code ${code}): ${summarizeReason(output)}`)));
    // Keep draining the pipes after startup so the server never blocks on output.
    const onData = (chunk) => {
      if (started) return;
      output += chunk;
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        started = true;
        clearTimeout(timer);
        child.removeAllListeners('exit');
        resolve({ child, url: match[1] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

// The server runs in its own process group (detached), so only that group is signalled;
// other OpenCode processes are never touched. The group is signalled only while Node has
// not reported the server's exit: until then the server (or its unreaped zombie) holds the
// PID, so the group ID cannot have been reused by an unrelated process. Once it has
// exited, nothing is signalled, even if members of its group may remain.
function killServerGroup(child, signal) {
  if (!child || !child.pid || hasExited(child)) return;
  try { process.kill(-child.pid, signal); } catch {}
}

function stopServer(child, graceMs) {
  if (!child || !child.pid || hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let forced = null;
    const timer = setTimeout(() => {
      killServerGroup(child, 'SIGKILL');
      forced = setTimeout(resolve, 1000); // SIGKILL cannot be ignored; just bound the wait
    }, graceMs);
    child.once('exit', () => { clearTimeout(timer); clearTimeout(forced); resolve(); });
    killServerGroup(child, 'SIGTERM');
  });
}

export async function runSelftest(opts = {}) {
  const log = opts.log || console.log;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts || {}) };
  const results = [];
  let interrupted = null;
  const record = (step, outcome, detail = '') => {
    if (interrupted) return; // the run is being torn down; later steps are meaningless
    results.push({ step, outcome, detail });
    log(`[${results.length}] ${`${step} `.padEnd(26, '.')} ${outcome.padEnd(4)}  ${detail}`);
  };

  let model;
  let source;
  try {
    ({ model, source } = resolveModel(opts));
  } catch (error) {
    record('Self-test', 'FAIL', error.message);
    return results;
  }
  const stateDir = getSessionDir();
  const cachePath = getCachePath();
  const password = randomBytes(24).toString('hex');
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

  // Everything this run creates; cleanup releases exactly these and nothing else.
  let project = null;
  let server = null;
  let url = null;
  let sid = null;
  const history = [];
  let recorder = null;

  // Aborted on interruption: the main workflow sends nothing more (no approvals) while,
  // and after, cleanup runs. Cleanup requests use their own time-boxed signal.
  const workflow = new AbortController();
  const send = async (method, route, body, signal) => {
    const response = await fetch(url + route, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!response.ok) throw new Error(`${method} ${route} -> HTTP ${response.status}`);
    return json;
  };
  const api = (method, route, body) => {
    if (workflow.signal.aborted) return Promise.reject(new Error('self-test interrupted'));
    return send(method, route, body, AbortSignal.any([AbortSignal.timeout(timeouts.request), workflow.signal]));
  };
  const cleanupApi = (method, route, body) => send(method, route, body, AbortSignal.timeout(timeouts.cleanupRequests));
  const pendingRequests = async (call = api) => {
    const list = await call('GET', '/permission');
    return Array.isArray(list) ? list.filter(item => item.sessionID === sid) : [];
  };
  const readState = () => {
    try { return JSON.parse(fs.readFileSync(path.join(stateDir, `${sid}.json`), 'utf8')); } catch { return null; }
  };
  const current = () => history[history.length - 1] || null;
  const describe = entry => (entry ? `${entry.status} [${summarizeReason(entry.reason, 80)}]` : 'no state file');
  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !workflow.signal.aborted) {
      const value = await predicate();
      if (value) return value;
      await sleep(POLL_MS);
    }
    return null;
  };
  const cacheEntry = () => readNotifyCache(cachePath)?.sessions?.[sid] ?? null;
  const askUser = async (question) => {
    if (!opts.ask || !process.stdin.isTTY) return null;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // In a terminal, readline turns Ctrl+C into an event instead of a signal; treat it
    // as the same interruption so cleanup and the exit code match a real SIGINT.
    rl.on('SIGINT', () => onSignal('SIGINT'));
    try {
      return /^y/i.test((await rl.question(`    ${question} [y/n] `)).trim());
    } finally {
      rl.close();
    }
  };
  const checkPopup = async (label, question) => {
    const seen = await askUser(question);
    if (seen === null) record(label, 'SKIP', 'not asked (non-interactive or --no-ask)');
    else record(label, seen ? 'PASS' : 'FAIL', seen ? 'you saw it' : 'you did not see it (check Do Not Disturb)');
  };

  // Idempotent: a signal, the normal finally block or both share one cleanup run.
  // Session requests are bounded by a short budget so shutdown never hangs.
  let cleaning = null;
  const cleanup = () => cleaning ??= (async () => {
    if (recorder) clearInterval(recorder);
    if (sid && url) {
      const removeSession = async () => {
        try {
          for (const extra of await pendingRequests(cleanupApi)) {
            await cleanupApi('POST', `/permission/${extra.id}/reply`, { reply: 'reject' });
          }
        } catch {}
        try { await cleanupApi('POST', `/session/${sid}/abort`); } catch {}
        try { await cleanupApi('DELETE', `/session/${sid}`); } catch {}
        await sleep(500);
      };
      await withinBudget(removeSession(), timeouts.cleanupRequests);
      try { fs.unlinkSync(path.join(stateDir, `${sid}.json`)); } catch {}
    }
    await stopServer(server, timeouts.killGrace);
    if (project) fs.rmSync(project, { recursive: true, force: true });
    log('Cleaned up the test session, server and temporary project.');
  })();

  // Second signal while cleaning up: stop waiting, remove what can be removed synchronously.
  const forceCleanup = () => {
    if (recorder) clearInterval(recorder);
    killServerGroup(server, 'SIGKILL');
    if (sid) { try { fs.unlinkSync(path.join(stateDir, `${sid}.json`)); } catch {} }
    if (project) fs.rmSync(project, { recursive: true, force: true });
  };

  function onSignal(signal) {
    const exitCode = SIGNAL_EXIT_CODES[signal] ?? 1;
    if (interrupted) {
      forceCleanup();
      process.exit(exitCode);
    }
    interrupted = signal;
    workflow.abort();
    log(`\nInterrupted (${signal}); cleaning up...`);
    cleanup().finally(() => process.exit(exitCode));
  }
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-selftest-'));
    fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      permission: { bash: 'ask', edit: 'deny', webfetch: 'deny' },
    }, null, 2));

    log(`LetItCook self-test (model: ${model ? `${model.providerID}/${model.modelID}` : 'default'}, ${source})`);
    log(`State dir: ${stateDir}`);

    ({ url } = await startServer(resolveOpenCodeBin(), project, password, timeouts.startup, (child) => { server = child; }));
    const session = await api('POST', '/session', { title: 'LetItCook self-test' });
    sid = session && session.id;
    if (!isValidSessionId(sid)) throw new Error('OpenCode returned an invalid session id');

    recorder = setInterval(() => {
      const state = readState();
      const last = current();
      if (state && (!last || last.status !== state.status || last.reason !== state.reason)) {
        history.push({ status: state.status, reason: state.reason, at: Date.now() });
      }
    }, POLL_MS);

    await api('POST', `/session/${sid}/prompt_async`, {
      ...(model ? { model } : {}),
      parts: [{ type: 'text', text: PROMPT }],
    });

    // 1. Cooking
    const cooking = await waitFor(() => history.find(entry => entry.status === 'cooking'), Math.min(60 * 1000, timeouts.agent));
    if (!cooking) {
      record('Cooking', 'FAIL', history.length ? describe(current()) :
        'no state file written; is the LetItCook plugin listed in your OpenCode config?');
      return results;
    }
    record('Cooking', 'PASS', describe(cooking));

    // 2. Real permission request -> Your Turn
    let request = null;
    const asked = await waitFor(async () => {
      if (current()?.status === 'burn') return 'burn';
      const pending = await pendingRequests();
      request = pending[0] || null;
      return request && current()?.status === 'your_turn' ? 'asked' : null;
    }, timeouts.agent);
    if (asked !== 'asked') {
      const detail = asked === 'burn'
        ? `${describe(current())}; check the model (--model provider/model)`
        : `no permission request within ${timeouts.agent / 1000}s (last: ${describe(current())})`;
      record('Permission request', 'FAIL', detail);
      return results;
    }
    const askedAt = current().at;
    if (!isApprovedRequest(request)) {
      await api('POST', `/permission/${request.id}/reply`, { reply: 'reject' });
      record('Permission request', 'FAIL', 'the model asked for a different command; rejected it');
      return results;
    }
    record('Permission request', 'PASS', describe(current()));

    // 3. GNOME extension notification for Your Turn
    const notified = await waitFor(() => {
      const entry = cacheEntry();
      return entry && entry.notifiedStatus === 'your_turn' && entry.notifiedAt >= askedAt - 1000 ? entry : null;
    }, timeouts.notify);
    record('Your Turn notification', notified ? 'PASS' : 'FAIL', notified
      ? `extension called Main.notify (+${Math.max(0, notified.notifiedAt - askedAt)} ms)`
      : 'extension recorded no notification; is it enabled? (gnome-extensions info letitcook@letitcook.local)');
    await checkPopup('Your Turn popup', "Did you see a 'LetItCook: opencode' Your Turn popup?");

    // 4. Approve the harmless command -> Cooking
    await api('POST', `/permission/${request.id}/reply`, { reply: 'once' });
    const resumed = await waitFor(() => {
      const entry = current();
      return entry && entry.at >= askedAt && entry.status === 'cooking' ? entry : null;
    }, 10 * 1000);
    record('Approved -> Cooking', resumed ? 'PASS' : 'FAIL', resumed ? describe(resumed) : describe(current()));

    // 5. Done (any further request is unexpected and rejected)
    let unexpected = false;
    const finished = await waitFor(async () => {
      for (const extra of await pendingRequests()) {
        unexpected = true;
        await api('POST', `/permission/${extra.id}/reply`, { reply: 'reject' });
      }
      const entry = current();
      return entry && ['done', 'burn', 'unknown'].includes(entry.status) && entry.at > askedAt ? entry : null;
    }, timeouts.agent);
    const done = finished?.status === 'done';
    record('Done', done && !unexpected ? 'PASS' : 'FAIL', finished
      ? `${describe(finished)}${unexpected ? '; the model made extra requests (rejected)' : ''}`
      : `not finished within ${timeouts.agent / 1000}s (last: ${describe(current())})`);

    // 6. Done notification is opt-in
    if (!done) {
      record('Done notification', 'SKIP', 'session did not reach Done');
    } else if (readNotifyCache(cachePath)?._config?.notifyDone !== true) {
      record('Done notification', 'SKIP', "'Notify on Done' is off (turn it on in the panel menu)");
    } else {
      const doneNotified = await waitFor(() => cacheEntry()?.notifiedStatus === 'done', timeouts.notify);
      record('Done notification', doneNotified ? 'PASS' : 'FAIL',
        doneNotified ? 'extension called Main.notify' : 'extension recorded no Done notification');
      if (doneNotified) await checkPopup('Done popup', "Did you see a 'LetItCook: opencode' Done popup?");
    }
    return results;
  } catch (error) {
    record('Self-test', 'FAIL', summarizeReason(error.message));
    return results;
  } finally {
    await cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectRun) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[letitcook-selftest] ${error.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(`LetItCook OpenCode self-test

Runs a private OpenCode server on 127.0.0.1 and checks the real flow:
Cooking -> permission request (Your Turn) -> GNOME notification -> Cooking -> Done.
Only "${SELFTEST_COMMAND}" is ever approved. Costs one short model call.

Usage:
  npm run selftest -- [--model provider/model] [--no-ask]

Options:
  --model provider/model  Model to use (default: LETITCOOK_SELFTEST_MODEL, else your
                          most recent OpenCode model, else OpenCode's default)
  --no-ask                Do not ask whether you saw the popups
`);
    process.exit(0);
  }
  const results = await runSelftest(opts);
  const failed = results.filter(result => result.outcome === 'FAIL').length;
  const skipped = results.filter(result => result.outcome === 'SKIP').map(result => result.step);
  if (failed > 0) console.log(`${failed} check(s) failed.`);
  else if (skipped.length > 0) console.log(`No check failed; ${skipped.length} not performed: ${skipped.join(', ')}.`);
  else console.log('All checks passed.');
  process.exit(failed === 0 ? 0 : 1);
}

export default { runSelftest, parseModel, isApprovedRequest, summarizeReason };
