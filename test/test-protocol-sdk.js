import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReporter } from '../src/protocol/sdk.js';
import { STATUS } from '../src/core/status.js';

function withDir(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-sdk-'));
  try {
    return fn(path.join(root, 'letitcook', 'sessions'), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testFullSession() {
  withDir((dir) => {
    const report = createReporter({ agent: 'mycli', sessionId: 'sdk-1', stateDir: dir, cwd: '/work', capabilities: ['requests', 'complete', 'fail', 'cancel'] });
    const status = () => JSON.parse(fs.readFileSync(path.join(dir, '@mycli.sdk-1.json'), 'utf8'));
    assert.deepStrictEqual(report.turnStarted(), { ok: true });
    assert.strictEqual(status().status, STATUS.COOKING);
    assert.strictEqual(status().pid, process.pid, 'defaults to the host process');
    const id = report.requestOpened({ kind: 'permission', subject: 'shell' });
    assert.ok(id);
    assert.strictEqual(status().status, STATUS.YOUR_TURN);
    assert.strictEqual(status().reason, 'permission:shell');
    report.activity('shell');
    assert.strictEqual(status().status, STATUS.YOUR_TURN);
    report.requestResolved(id, 'approved');
    assert.strictEqual(status().status, STATUS.COOKING);
    report.subagentStarted('helper');
    report.subagentStopped('helper');
    assert.strictEqual(status().status, STATUS.COOKING);
    report.turnCompleted();
    assert.strictEqual(status().status, STATUS.DONE);
    report.turnStarted();
    report.turnCancelled();
    assert.strictEqual(status().status, STATUS.YOUR_TURN);
    report.turnStarted();
    report.turnFailed('rate_limit');
    assert.strictEqual(status().status, STATUS.BURN);
    assert.strictEqual(status().reason, 'error:rate_limit');
    report.sessionEnded();
    assert.ok(!fs.existsSync(path.join(dir, '@mycli.sdk-1.json')));
  });
}

function testTwoReportersSameSessionDoNotCollide() {
  withDir((dir) => {
    // Event ids carry a per-reporter instance, so a restarted CLI never repeats one.
    const a = createReporter({ agent: 'mycli', sessionId: 'sdk-2', stateDir: dir });
    const b = createReporter({ agent: 'mycli', sessionId: 'sdk-2', stateDir: dir });
    a.turnStarted();
    a.turnCompleted();
    b.turnStarted();
    const state = JSON.parse(fs.readFileSync(path.join(dir, '@mycli.sdk-2.json'), 'utf8'));
    assert.strictEqual(state.status, STATUS.COOKING, "the restarted reporter's events are not taken for duplicates");
  });
}

function testNeverThrows() {
  withDir((dir, root) => {
    assert.deepStrictEqual(createReporter({ agent: 'claude', sessionId: 's', stateDir: dir }).turnStarted(), { ok: false, error: 'reserved_agent' });
    assert.deepStrictEqual(createReporter({ agent: 'mycli', sessionId: '../s', stateDir: dir }).turnStarted(), { ok: false, error: 'invalid_session_id' });
    assert.strictEqual(createReporter({ agent: 'mycli', sessionId: 's', stateDir: dir }).requestOpened({ subject: 'rm -rf /' }), null, 'rejected request has no id');
    fs.writeFileSync(path.join(root, 'file'), '');
    assert.deepStrictEqual(createReporter({ agent: 'mycli', sessionId: 's', stateDir: path.join(root, 'file', 'x') }).turnStarted(), { ok: false, error: 'write_failed' });
    const late = createReporter({ agent: 'mycli', sessionId: 's', stateDir: dir, clock: () => 5 });
    assert.deepStrictEqual(late.turnStarted(), { ok: false, error: 'stale_time' });
  });
}

function run() {
  testFullSession();
  testTwoReportersSameSessionDoNotCollide();
  testNeverThrows();
  console.log('All LetItCook protocol SDK tests passed.');
}

run();
