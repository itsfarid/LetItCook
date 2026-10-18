import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  STATUS,
  STATUS_META,
  normalizeSession,
  aggregateState,
} from '../src/core/status.js';
import {
  mapOpenCodeEvent,
  mapToolHook,
  writeSessionFile,
  deleteSessionFile,
  readAllSessionsFromDir,
  OpenCodeAdapter,
} from '../src/adapters/opencode/adapter.js';

function testNormalizeSingleSession() {
  const now = 1000000;

  // 1. Valid states
  for (const s of [STATUS.COOKING, STATUS.YOUR_TURN, STATUS.DONE, STATUS.BURN, STATUS.UNKNOWN]) {
    const norm = normalizeSession({
      session_id: 's1',
      agent: 'opencode',
      status: s,
      updated_at: now,
    }, { now });
    assert.strictEqual(norm.status, s, `Status ${s} should match`);
    assert.strictEqual(norm.stale, false);
  }

  // 2. Invalid state -> Unknown
  const invalid = normalizeSession({
    session_id: 's2',
    status: 'foo_bar_invalid',
    updated_at: now,
  }, { now });
  assert.strictEqual(invalid.status, STATUS.UNKNOWN);

  // 3. Null / empty object -> Unknown
  const empty = normalizeSession(null, { now });
  assert.strictEqual(empty.status, STATUS.UNKNOWN);
  assert.strictEqual(empty.stale, true);

  // 4. Stale Cooking -> Unknown
  const staleCooking = normalizeSession({
    session_id: 's3',
    status: STATUS.COOKING,
    updated_at: now - 400000, // 400s ago (> 300s default)
  }, { now, staleMs: 300000 });
  assert.strictEqual(staleCooking.status, STATUS.UNKNOWN);
  assert.strictEqual(staleCooking.stale, true);

  // 5. Stale Your Turn -> Unknown
  const staleYourTurn = normalizeSession({
    session_id: 's4',
    status: STATUS.YOUR_TURN,
    updated_at: now - 350000,
  }, { now, staleMs: 300000 });
  assert.strictEqual(staleYourTurn.status, STATUS.UNKNOWN);
  assert.strictEqual(staleYourTurn.stale, true);

  // 6. Done is not invalidated by staleness
  const oldDone = normalizeSession({
    session_id: 's5',
    status: STATUS.DONE,
    updated_at: now - 999999,
  }, { now, staleMs: 300000 });
  assert.strictEqual(oldDone.status, STATUS.DONE);
  assert.strictEqual(oldDone.stale, false);

  // 7. Dead PID check -> Unknown
  const deadPidSession = normalizeSession({
    session_id: 's6',
    status: STATUS.COOKING,
    pid: 999999,
    updated_at: now - 1000,
  }, {
    now,
    staleMs: 300000,
    isPidAlive: (pid) => pid === 1234,
  });
  assert.strictEqual(deadPidSession.status, STATUS.UNKNOWN);
  assert.strictEqual(deadPidSession.stale, true);

  const alivePidSession = normalizeSession({
    session_id: 's7',
    status: STATUS.COOKING,
    pid: 1234,
    updated_at: now - 1000,
  }, {
    now,
    staleMs: 300000,
    isPidAlive: (pid) => pid === 1234,
  });
  assert.strictEqual(alivePidSession.status, STATUS.COOKING);
  assert.strictEqual(alivePidSession.stale, false);
}

function testAggregateState() {
  const now = 1000000;

  // Empty -> Unknown
  const emptyAgg = aggregateState([]);
  assert.strictEqual(emptyAgg.status, STATUS.UNKNOWN);
  assert.strictEqual(emptyAgg.sessionCount, 0);

  // Single Cooking
  const sCooking = { session_id: '1', status: STATUS.COOKING, updated_at: now };
  assert.strictEqual(aggregateState([sCooking], { now }).status, STATUS.COOKING);

  // Single Done
  const sDone = { session_id: '2', status: STATUS.DONE, updated_at: now };
  assert.strictEqual(aggregateState([sDone], { now }).status, STATUS.DONE);

  // Cooking + Done -> Cooking wins
  assert.strictEqual(aggregateState([sDone, sCooking], { now }).status, STATUS.COOKING);

  // Your Turn + Cooking -> Your Turn wins
  const sYourTurn = { session_id: '3', status: STATUS.YOUR_TURN, updated_at: now };
  assert.strictEqual(aggregateState([sCooking, sYourTurn], { now }).status, STATUS.YOUR_TURN);

  // Burn + Your Turn + Cooking -> Burn wins
  const sBurn = { session_id: '4', status: STATUS.BURN, updated_at: now };
  assert.strictEqual(aggregateState([sCooking, sYourTurn, sBurn], { now }).status, STATUS.BURN);

  // All Done -> Done
  const sDone2 = { session_id: '5', status: STATUS.DONE, updated_at: now };
  assert.strictEqual(aggregateState([sDone, sDone2], { now }).status, STATUS.DONE);

  // Stale Cooking + Done -> Done wins because Stale Cooking becomes Unknown
  const sStaleCooking = { session_id: '6', status: STATUS.COOKING, updated_at: now - 500000 };
  const aggStale = aggregateState([sStaleCooking, sDone], { now, staleMs: 300000 });
  assert.strictEqual(aggStale.status, STATUS.DONE);
}

function testOpenCodeEventMapping() {
  // session.created
  const evCreated = mapOpenCodeEvent({
    type: 'session.created',
    properties: { sessionID: 'ses_1', directory: '/home/user/project', title: 'Init Task' },
    pid: 1234,
  });
  assert.strictEqual(evCreated.status, STATUS.COOKING);
  assert.strictEqual(evCreated.session_id, 'ses_1');
  assert.strictEqual(evCreated.cwd, '/home/user/project');

  // permission.asked -> Your Turn
  const evPerm = mapOpenCodeEvent({
    type: 'permission.asked',
    properties: { sessionID: 'ses_1', permission: 'bash:execute', patterns: ['rm -rf /tmp'] },
  }, evCreated);
  assert.strictEqual(evPerm.status, STATUS.YOUR_TURN);
  assert.strictEqual(evPerm.cwd, '/home/user/project');

  // question.asked -> Your Turn
  const evQuestion = mapOpenCodeEvent({
    type: 'question.asked',
    properties: { sessionID: 'ses_1', question: 'Select deployment target' },
  }, evCreated);
  assert.strictEqual(evQuestion.status, STATUS.YOUR_TURN);

  // permission.replied -> Cooking
  const evPermReply = mapOpenCodeEvent({
    type: 'permission.replied',
    properties: { sessionID: 'ses_1', reply: 'granted' },
  }, evPerm);
  assert.strictEqual(evPermReply.status, STATUS.COOKING);

  // message.updated (assistant) -> Cooking
  const evMsg = mapOpenCodeEvent({
    type: 'message.updated',
    properties: { sessionID: 'ses_1', role: 'assistant' },
  }, evPermReply);
  assert.strictEqual(evMsg.status, STATUS.COOKING);

  // session.idle -> Unknown (idle is not proof of completion)
  const evIdle = mapOpenCodeEvent({
    type: 'session.idle',
    properties: { sessionID: 'ses_1' },
  }, evMsg);
  assert.strictEqual(evIdle.status, STATUS.UNKNOWN);

  // session.error -> Burn
  const evError = mapOpenCodeEvent({
    type: 'session.error',
    properties: { sessionID: 'ses_1', error: { message: 'Out of memory' } },
  }, evMsg);
  assert.strictEqual(evError.status, STATUS.BURN);
  assert.ok(evError.reason.includes('Out of memory'));

  // session.deleted -> deleted flag
  const evDeleted = mapOpenCodeEvent({
    type: 'session.deleted',
    properties: { sessionID: 'ses_1' },
  }, evIdle);
  assert.strictEqual(evDeleted.deleted, true);

  // Tool hooks
  const toolBeforeNormal = mapToolHook('before', { sessionID: 'ses_1', tool: 'bash' }, evCreated);
  assert.strictEqual(toolBeforeNormal.status, STATUS.COOKING);

  const toolBeforeQuestion = mapToolHook('before', { sessionID: 'ses_1', tool: 'ask_user_input' }, evCreated);
  assert.strictEqual(toolBeforeQuestion.status, STATUS.YOUR_TURN);

  const toolAfterQuestion = mapToolHook('after', { sessionID: 'ses_1', tool: 'ask_user_input' }, toolBeforeQuestion);
  assert.strictEqual(toolAfterQuestion.status, STATUS.COOKING);
}

function testFileSystemOperations() {
  const tmpDir = path.join(os.tmpdir(), `letitcook_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);

  try {
    const s1 = {
      session_id: 'test_ses_1',
      agent: 'opencode',
      status: STATUS.COOKING,
      reason: 'testing file write',
      title: 'Test 1',
      cwd: '/tmp/test1',
      pid: process.pid,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const s2 = {
      session_id: 'test_ses_2',
      agent: 'opencode',
      status: STATUS.YOUR_TURN,
      reason: 'permission.asked:bash',
      title: 'Test 2',
      cwd: '/tmp/test2',
      pid: process.pid,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    writeSessionFile(s1, tmpDir);
    writeSessionFile(s2, tmpDir);

    const readBack = readAllSessionsFromDir(tmpDir);
    assert.strictEqual(readBack.length, 2);

    const agg = aggregateState(readBack);
    assert.strictEqual(agg.status, STATUS.YOUR_TURN);
    assert.strictEqual(agg.sessionCount, 2);

    deleteSessionFile('test_ses_2', tmpDir);
    const readAfterDelete = readAllSessionsFromDir(tmpDir);
    assert.strictEqual(readAfterDelete.length, 1);
    assert.strictEqual(readAfterDelete[0].session_id, 'test_ses_1');

    deleteSessionFile('test_ses_1', tmpDir);
    const readEmpty = readAllSessionsFromDir(tmpDir);
    assert.strictEqual(readEmpty.length, 0);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

function testOpenCodeAdapterContract() {
  const adapter = new OpenCodeAdapter();
  assert.strictEqual(adapter.id, 'opencode');
  assert.strictEqual(adapter.name, 'OpenCode');
  assert.strictEqual(typeof adapter.isAvailable, 'function');
  assert.strictEqual(typeof adapter.detectSessions, 'function');
  assert.strictEqual(typeof adapter.getSessionState, 'function');
  assert.strictEqual(typeof adapter.normalizeState, 'function');
  assert.strictEqual(typeof adapter.startMonitoring, 'function');
  assert.strictEqual(typeof adapter.stopMonitoring, 'function');
}

// Availability is checked in controlled environments, so the result does not depend on
// whether OpenCode happens to be installed where the tests run.
function testOpenCodeAdapterAvailability() {
  const adapter = new OpenCodeAdapter();
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, OPENCODE_BIN: process.env.OPENCODE_BIN };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-avail-'));
  try {
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    process.env.HOME = home;
    process.env.PATH = path.join(root, 'empty');
    delete process.env.OPENCODE_BIN;
    assert.strictEqual(adapter.isAvailable(), false, 'not available without binary, PATH entry or ~/.opencode');
    process.env.OPENCODE_BIN = '/opt/opencode';
    assert.strictEqual(adapter.isAvailable(), true, 'OPENCODE_BIN makes it available');
    delete process.env.OPENCODE_BIN;
    fs.writeFileSync(path.join(bin, 'opencode'), '', { mode: 0o755 });
    process.env.PATH = bin;
    assert.strictEqual(adapter.isAvailable(), true, 'opencode on PATH makes it available');
    process.env.PATH = path.join(root, 'empty');
    fs.mkdirSync(path.join(home, '.opencode'));
    assert.strictEqual(adapter.isAvailable(), true, '~/.opencode makes it available');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testOpenCodeAdapterSessionDiscovery() {
  const tmpDir = path.join(os.tmpdir(), `letitcook_adapter_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  try {
    const adapter = new OpenCodeAdapter();
    assert.deepStrictEqual(adapter.detectSessions({ baseDir: tmpDir }), [], 'Empty dir discovers no sessions');

    writeSessionFile({
      session_id: 'ses_abc',
      agent: 'opencode',
      status: STATUS.COOKING,
      reason: 'testing',
      title: 'Discovery',
      cwd: '/tmp/x',
      pid: process.pid,
      created_at: Date.now(),
      updated_at: Date.now(),
    }, tmpDir);

    const found = adapter.detectSessions({ baseDir: tmpDir });
    assert.strictEqual(found.length, 1, 'Discovers exactly one session');
    assert.strictEqual(found[0].agent, 'opencode');
    assert.strictEqual(found[0].status, STATUS.COOKING);

    const single = adapter.getSessionState('ses_abc', { baseDir: tmpDir });
    assert.ok(single, 'getSessionState returns a session');
    assert.strictEqual(single.session_id, 'ses_abc');

    assert.strictEqual(adapter.getSessionState('ses_missing', { baseDir: tmpDir }), null, 'Missing session returns null');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function testOpenCodeAdapterNormalization() {
  const adapter = new OpenCodeAdapter();

  const norm = adapter.normalizeState({ session_id: 's1', status: STATUS.YOUR_TURN, updated_at: 1000 }, { now: 1000 });
  assert.strictEqual(norm.status, STATUS.YOUR_TURN);
  assert.strictEqual(norm.agent, 'opencode', 'agent id forced to adapter id');

  const invalid = adapter.normalizeState({ session_id: 's2', status: 'bogus', updated_at: 1000 }, { now: 1000 });
  assert.strictEqual(invalid.status, STATUS.UNKNOWN);

  const none = adapter.normalizeState(null, { now: 1000 });
  assert.strictEqual(none.status, STATUS.UNKNOWN);
}

function run() {
  testNormalizeSingleSession();
  testAggregateState();
  testOpenCodeEventMapping();
  testFileSystemOperations();
  testOpenCodeAdapterContract();
  testOpenCodeAdapterAvailability();
  testOpenCodeAdapterSessionDiscovery();
  testOpenCodeAdapterNormalization();
  console.log('All LetItCook state tests passed.');
}

run();
