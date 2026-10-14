import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATUS, aggregateState } from '../src/core/status.js';
import {
  mapOpenCodeEvent,
  mapToolHook,
  writeSessionFile,
  deleteSessionFile,
  readAllSessionsFromDir,
} from '../src/adapters/opencode/adapter.js';

async function testFullOpenCodeLifecycle() {
  const testDir = path.join(os.tmpdir(), `letitcook_e2e_${Date.now()}`);

  try {
    let state = null;

    // Step 1: session.created
    state = mapOpenCodeEvent({
      type: 'session.created',
      properties: { sessionID: 'e2e_ses_1', directory: '/home/user/app', title: 'Feature App' },
      pid: process.pid,
    }, state);
    writeSessionFile(state, testDir);

    let current = readAllSessionsFromDir(testDir);
    let agg = aggregateState(current);
    assert.strictEqual(agg.status, STATUS.COOKING, 'Step 1 should be Cooking');
    assert.strictEqual(agg.sessionCount, 1);

    // Step 2: tool execution (bash)
    state = mapToolHook('before', { sessionID: 'e2e_ses_1', tool: 'bash' }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(aggregateState(current).status, STATUS.COOKING, 'Step 2 should be Cooking');

    // Step 3: permission.asked -> Your Turn
    state = mapOpenCodeEvent({
      type: 'permission.asked',
      properties: { sessionID: 'e2e_ses_1', permission: 'bash:exec', patterns: ['rm -rf /tmp/cache'] },
    }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(aggregateState(current).status, STATUS.YOUR_TURN, 'Step 3 should be Your Turn');

    // Step 4: permission.replied -> Cooking
    state = mapOpenCodeEvent({
      type: 'permission.replied',
      properties: { sessionID: 'e2e_ses_1', reply: 'approved' },
    }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(aggregateState(current).status, STATUS.COOKING, 'Step 4 should return to Cooking');

    // Step 5: question.asked -> Your Turn
    state = mapOpenCodeEvent({
      type: 'question.asked',
      properties: { sessionID: 'e2e_ses_1', question: 'Which framework?' },
    }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(aggregateState(current).status, STATUS.YOUR_TURN, 'Step 5 should be Your Turn');

    // Step 6: question.replied -> Cooking
    state = mapOpenCodeEvent({
      type: 'question.replied',
      properties: { sessionID: 'e2e_ses_1', reply: 'express' },
    }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(aggregateState(current).status, STATUS.COOKING, 'Step 6 should be Cooking');

    // Step 7: session.idle does not prove successful completion
    state = mapOpenCodeEvent({
      type: 'session.idle',
      properties: { sessionID: 'e2e_ses_1' },
    }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(aggregateState(current).status, STATUS.UNKNOWN, 'Step 7 idle state should remain Unknown');

    // Step 8: Multi-session concurrency test
    // Add second session in cooking
    let state2 = mapOpenCodeEvent({
      type: 'session.created',
      properties: { sessionID: 'e2e_ses_2', directory: '/home/user/backend', title: 'API server' },
      pid: process.pid,
    });
    writeSessionFile(state2, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(current.length, 2);
    // Session 1 Done + Session 2 Cooking => Cooking
    assert.strictEqual(aggregateState(current).status, STATUS.COOKING, 'Done + Cooking should aggregate to Cooking');

    // Second session asks permission -> Your Turn
    state2 = mapOpenCodeEvent({
      type: 'permission.asked',
      properties: { sessionID: 'e2e_ses_2', permission: 'write_file' },
    }, state2);
    writeSessionFile(state2, testDir);
    current = readAllSessionsFromDir(testDir);
    // Session 1 Done + Session 2 Your Turn => Your Turn
    assert.strictEqual(aggregateState(current).status, STATUS.YOUR_TURN, 'Done + Your Turn should aggregate to Your Turn');

    // First session errors -> Burn
    state = mapOpenCodeEvent({
      type: 'session.error',
      properties: { sessionID: 'e2e_ses_1', error: { message: 'Connection reset' } },
    }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    // Session 1 Burn + Session 2 Your Turn => Burn (Burn is highest priority)
    assert.strictEqual(aggregateState(current).status, STATUS.BURN, 'Burn + Your Turn should aggregate to Burn');

    // Delete session 1
    const del1 = mapOpenCodeEvent({
      type: 'session.deleted',
      properties: { sessionID: 'e2e_ses_1' },
    }, state);
    assert.strictEqual(del1.deleted, true);
    deleteSessionFile('e2e_ses_1', testDir);

    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(current.length, 1);
    assert.strictEqual(aggregateState(current).status, STATUS.YOUR_TURN, 'Remaining session is Your Turn');

    // Delete session 2
    deleteSessionFile('e2e_ses_2', testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(current.length, 0);
    assert.strictEqual(aggregateState(current).status, STATUS.UNKNOWN, 'No sessions aggregates to Unknown');

    // Stale handling test:
    const staleSession = {
      session_id: 'e2e_stale',
      agent: 'opencode',
      status: STATUS.COOKING,
      reason: 'hung task',
      title: 'Hung',
      cwd: '/tmp',
      pid: 999999,
      updated_at: Date.now() - 400000,
    };
    writeSessionFile(staleSession, testDir);
    current = readAllSessionsFromDir(testDir, { staleMs: 300000, isPidAlive: (pid) => pid === process.pid });
    assert.strictEqual(current[0].status, STATUS.UNKNOWN, 'Hung session with dead PID/old timestamp becomes Unknown');
    assert.strictEqual(aggregateState(current, { staleMs: 300000, isPidAlive: (pid) => pid === process.pid }).status, STATUS.UNKNOWN);

    // Corrupted file test:
    fs.writeFileSync(path.join(testDir, 'corrupt.json'), 'NOT VALID JSON', 'utf8');
    const corruptedRead = readAllSessionsFromDir(testDir);
    assert.strictEqual(corruptedRead.some(s => s.status === STATUS.UNKNOWN && s.reason.includes('corrupted')), true);

    console.log('All LetItCook integration tests passed.');
  } finally {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

function testOpenCodeIdleSignalsAreConservative() {
  const cooking = { session_id: 'idle-test', status: STATUS.COOKING, agent: 'opencode' };
  const waiting = { ...cooking, status: STATUS.YOUR_TURN };
  const failed = { ...cooking, status: STATUS.BURN };

  for (const previous of [null, cooking, waiting, failed]) {
    const idle = mapOpenCodeEvent({
      type: 'session.idle',
      properties: { sessionID: 'idle-test' },
    }, previous);
    assert.strictEqual(idle.status, STATUS.UNKNOWN, 'session.idle never implies a user-facing state');
  }

  assert.strictEqual(mapOpenCodeEvent({
    type: 'session.status', properties: { sessionID: 'idle-test', status: 'idle' },
  }).status, STATUS.UNKNOWN, 'idle status without prior evidence is Unknown');
  assert.strictEqual(mapOpenCodeEvent({
    type: 'session.status', properties: { sessionID: 'idle-test', status: 'idle' },
  }, cooking).status, STATUS.COOKING, 'idle status does not infer Done');
  assert.strictEqual(mapOpenCodeEvent({
    type: 'session.compacted', properties: { sessionID: 'idle-test' },
  }, waiting).status, STATUS.YOUR_TURN, 'compaction preserves prior known state rather than claiming completion');
  assert.strictEqual(mapOpenCodeEvent({
    type: 'session.compacted', properties: { sessionID: 'idle-test' },
  }).status, STATUS.UNKNOWN, 'compaction without prior state is Unknown');
}

testOpenCodeIdleSignalsAreConservative();
testFullOpenCodeLifecycle();
