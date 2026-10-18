// The generic event protocol end to end: `node src/hooks/hook.js event` with one JSON event
// on stdin, through the shared bridge and reducer, into the state directory.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ProtocolAdapter, protocolHooks } from '../src/protocol/adapter.js';
import { createDefaultRegistry } from '../src/core/registry.js';
import { STATUS } from '../src/core/status.js';
import { applySignals } from '../src/hooks/bridge.js';
import { SIGNAL } from '../src/core/lifecycle.js';

const HOOK = path.resolve('src/hooks/hook.js');

let counter = 0;
function event(type, extra = {}) {
  return { schema: 1, agent: 'mycli', session_id: 's1', event_id: `e${++counter}`, type, time: Date.now(), ...extra };
}

function emit(home, input) {
  const result = spawnSync(process.execPath, [HOOK, 'event'], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: home },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(result.status, 0, 'always exits 0');
  assert.strictEqual(result.stdout + result.stderr, '', 'prints nothing');
}

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-protocol-'));
  const dir = path.join(home, 'letitcook', 'sessions');
  try {
    return fn(home, dir);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

function testCommandTransport() {
  withHome((home, dir) => {
    emit(home, event('turn.started', { turn_id: 't1', cwd: '/work', capabilities: ['requests', 'complete'] }));
    const file = path.join(dir, '@mycli.s1.json');
    let state = read(dir, '@mycli.s1.json');
    assert.strictEqual(state.status, STATUS.COOKING);
    assert.strictEqual(state.agent, 'mycli');
    assert.strictEqual(state.cwd, '/work');
    assert.strictEqual(state.pid, process.pid, 'the process that ran the command');
    assert.deepStrictEqual(state.capabilities, ['complete', 'requests']);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

    emit(home, event('request.opened', { turn_id: 't1', request_id: 'p1', subject: 'shell' }));
    assert.strictEqual(read(dir, '@mycli.s1.json').status, STATUS.YOUR_TURN);
    assert.strictEqual(read(dir, '@mycli.s1.json').reason, 'permission:shell');
    emit(home, event('request.resolved', { request_id: 'p1', outcome: 'approved' }));
    emit(home, event('turn.failed', { turn_id: 't1', error_code: 'quota' }));
    assert.strictEqual(read(dir, '@mycli.s1.json').status, STATUS.COOKING, 'an undeclared outcome (fail) is ignored');
    emit(home, event('turn.completed', { turn_id: 't1', pid: 4242 }));
    state = read(dir, '@mycli.s1.json');
    assert.strictEqual(state.status, STATUS.DONE);
    assert.strictEqual(state.pid, 4242, 'the event may name the agent process');

    emit(home, event('session.ended'));
    assert.ok(!fs.existsSync(file), 'session.ended removes the session');
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'no lock or temporary files left');
  });
}

// A producer that resumes a session after a restart: the earlier run's session.ended,
// delivered late, does not remove the resumed session (Devin review on PR #7).
function testLateSessionEndDoesNotRemoveAResumedSession() {
  withHome((home, dir) => {
    const t = Date.now();
    emit(home, event('turn.started', { turn_id: 'old', time: t - 3000 }));
    emit(home, event('turn.started', { turn_id: 'new', time: t - 1000 }));
    emit(home, event('session.ended', { time: t - 2000 }));
    assert.strictEqual(read(dir, '@mycli.s1.json').status, STATUS.COOKING, 'the resumed session stays');
    emit(home, event('session.ended', { time: t }));
    assert.ok(!fs.existsSync(path.join(dir, '@mycli.s1.json')), 'a current end removes it');
  });
}

function testRejectedEventsWriteNothing() {
  withHome((home, dir) => {
    const rejected = [
      'not json',
      '[1,2]',
      JSON.stringify(event('turn.started', { schema: 2 })),
      JSON.stringify(event('turn.started', { agent: 'claude' })),
      JSON.stringify(event('turn.started', { agent: 'copilot' })),
      JSON.stringify(event('turn.started', { session_id: '../../x' })),
      JSON.stringify(event('turn.started', { agent: 'a.b' })),
      JSON.stringify(event('turn.started', { time: Date.now() - 2 * 24 * 60 * 60 * 1000 })),
      JSON.stringify(event('turn.paused')),
      JSON.stringify(event('turn.started', { padding: 'x'.repeat(17 * 1024) })),
    ];
    for (const input of rejected) emit(home, input);
    assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, 'no session from invalid, reserved, stale, unknown or oversized events');
  });
}

function testNativeSessionsCannotBeTouched() {
  withHome((home, dir) => {
    applySignals('claude', [{ type: SIGNAL.TURN_START, sessionId: 's1' }], { stateDir: dir, pid: null });
    fs.writeFileSync(path.join(dir, 'ses_s1.json'), JSON.stringify({ session_id: 'ses_s1', agent: 'opencode', status: 'cooking' }), { mode: 0o600 });
    const before = fs.readdirSync(dir).map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
    // Same session ids, other producer: separate @ files, native files untouched.
    emit(home, event('turn.started', { agent: 'ses', session_id: 's1' }));
    emit(home, event('turn.completed', { session_id: 'ses_s1' }));
    for (const [f, content] of before) assert.strictEqual(fs.readFileSync(path.join(dir, f), 'utf8'), content, `${f} untouched`);
    assert.ok(fs.existsSync(path.join(dir, '@ses.s1.json')));
  });
}

function testSymlinkedSessionFileIsReplacedNotFollowed() {
  withHome((home, dir) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outside = path.join(home, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ session_id: 's1', agent: 'mycli', status: 'done' }), { mode: 0o600 });
    fs.symlinkSync(outside, path.join(dir, '@mycli.s1.json'));
    emit(home, event('activity'));
    assert.strictEqual(JSON.parse(fs.readFileSync(outside, 'utf8')).status, 'done', 'the link target is never written');
    assert.ok(!fs.lstatSync(path.join(dir, '@mycli.s1.json')).isSymbolicLink(), 'the link is replaced by a regular file');
    assert.strictEqual(read(dir, '@mycli.s1.json').status, STATUS.COOKING, 'its content is not trusted');
  });
}

function testUntrustedStateDirectory() {
  withHome((home) => {
    const shared = path.join(home, 'shared');
    fs.mkdirSync(shared, { mode: 0o777 });
    fs.chmodSync(shared, 0o777);
    fs.mkdirSync(path.join(home, 'letitcook'), { mode: 0o700 });
    fs.symlinkSync(shared, path.join(home, 'letitcook', 'sessions'));
    emit(home, event('turn.started'));
    assert.deepStrictEqual(fs.readdirSync(shared), [], 'nothing is written to a directory other users can access');
    assert.strictEqual(fs.statSync(shared).mode & 0o777, 0o777, 'and it is never chmod-ed');
  });
}

async function testConcurrentProducers() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-protocol-'));
  const dir = path.join(home, 'letitcook', 'sessions');
  try {
    emit(home, event('turn.started', { turn_id: 't1' }));
    const runs = Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK, 'event'], { env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: home } });
      child.stdin.end(JSON.stringify(event('request.opened', { turn_id: 't1', request_id: `r${i}` })));
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    }));
    await Promise.all(runs);
    const state = read(dir, '@mycli.s1.json');
    assert.deepStrictEqual(Object.keys(state.lifecycle.pending).sort(), Array.from({ length: 8 }, (_, i) => `r${i}`).sort(), 'no request lost');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testRegistryAdapter() {
  withHome((home, dir) => {
    const adapter = new ProtocolAdapter();
    assert.strictEqual(adapter.isAvailable({ baseDir: dir }), false, 'not in use without sessions');
    emit(home, event('turn.started', { session_id: 'a' }));
    emit(home, event('turn.started', { agent: 'other-cli', session_id: 'b' }));
    applySignals('claude', [{ type: SIGNAL.TURN_START, sessionId: 'c' }], { stateDir: dir, pid: null });
    assert.deepStrictEqual(adapter.detectSessions({ baseDir: dir }).map(s => `${s.agent}/${s.session_id}`).sort(), ['mycli/a', 'other-cli/b'],
      'lists protocol sessions only');
    assert.strictEqual(adapter.isAvailable({ baseDir: dir }), true);
    assert.strictEqual(adapter.getSessionState('a', { baseDir: dir, agent: 'mycli' }).status, STATUS.COOKING);
    assert.strictEqual(adapter.getSessionState('c', { baseDir: dir, agent: 'claude' }), null, 'never a native session');
    assert.strictEqual(adapter.getSessionState('a', { baseDir: dir }), null, 'needs the agent');
  });
  assert.ok(createDefaultRegistry().get('protocol') instanceof ProtocolAdapter);
  assert.strictEqual(protocolHooks.maxInputBytes, 16 * 1024);
}

async function run() {
  testCommandTransport();
  testLateSessionEndDoesNotRemoveAResumedSession();
  testRejectedEventsWriteNothing();
  testNativeSessionsCannotBeTouched();
  testSymlinkedSessionFileIsReplacedNotFollowed();
  testUntrustedStateDirectory();
  await testConcurrentProducers();
  testRegistryAdapter();
  console.log('All LetItCook event protocol adapter tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
