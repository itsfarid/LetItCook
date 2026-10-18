import assert from 'node:assert';
import { SIGNAL, validateSignal, reduceSession, shouldPersist, HEARTBEAT_MS } from '../src/core/lifecycle.js';
import { STATUS, normalizeSession } from '../src/core/status.js';

const SID = 'sess-1';
const ctx = (now = 1000) => ({ agent: 'test', now, pid: 4242 });

// Applies signals in order; returns every intermediate record.
function run(signals, start = null) {
  let state = start;
  const trace = [];
  let now = 1000;
  for (const signal of signals) {
    now += 10;
    const next = reduceSession(state, { sessionId: SID, ...signal }, ctx(now));
    if (next) state = next;
    trace.push(state);
  }
  return { state, trace };
}

function testValidation() {
  assert.strictEqual(validateSignal(null), null);
  assert.strictEqual(validateSignal({ type: 'bogus', sessionId: SID }), null, 'unknown signal type');
  assert.strictEqual(validateSignal({ type: SIGNAL.ACTIVITY, sessionId: '../etc' }), null, 'unsafe session id');
  assert.strictEqual(validateSignal({ type: SIGNAL.ACTIVITY }), null, 'missing session id');
  assert.strictEqual(validateSignal({ type: SIGNAL.ACTIVITY, sessionId: SID, parentSessionId: 'a/b' }), null, 'unsafe parent id');
  const clean = validateSignal({ type: SIGNAL.ACTIVITY, sessionId: SID, reason: `a\nb${'x'.repeat(500)}`, cwd: 7 });
  assert.ok(clean.reason.length <= 120 && !clean.reason.includes('\n'), 'reason bounded, no control characters');
  assert.strictEqual(clean.cwd, '', 'non-string fields are dropped');
  assert.strictEqual(reduceSession(null, { type: 'bogus', sessionId: SID }, ctx()), null, 'unsupported signals change nothing');
}

function testTurnLifecycle() {
  const { trace } = run([
    { type: SIGNAL.TURN_START },
    { type: SIGNAL.ACTIVITY, reason: 'tool:Bash' },
    { type: SIGNAL.TURN_COMPLETE },
  ]);
  assert.deepStrictEqual(trace.map(s => s.status), [STATUS.COOKING, STATUS.COOKING, STATUS.DONE]);
  const done = trace[2];
  assert.strictEqual(done.agent, 'test');
  assert.strictEqual(done.pid, 4242);
  assert.strictEqual(done.confidence, 'high');
  assert.strictEqual(normalizeSession(done, { now: done.updated_at }).status, STATUS.DONE, 'records are valid session files');
}

function testFailureAndCancel() {
  assert.strictEqual(run([{ type: SIGNAL.TURN_START }, { type: SIGNAL.FAILURE, reason: 'error:rate_limit' }]).state.status, STATUS.BURN);
  const cancelled = run([{ type: SIGNAL.TURN_START }, { type: SIGNAL.CANCEL }]).state;
  assert.strictEqual(cancelled.status, STATUS.YOUR_TURN, 'a user cancel hands the turn back, it is not Burn');
}

function testTurnEndWithoutOutcome() {
  const { state } = run([
    { type: SIGNAL.TURN_START },
    { type: SIGNAL.REQUEST_OPEN, requestId: 'r1' },
    { type: SIGNAL.TURN_END },
  ]);
  assert.strictEqual(state.status, STATUS.YOUR_TURN, 'a turn without a reported outcome is never Done');
  assert.deepStrictEqual(state.lifecycle.pending, {});
  assert.strictEqual(run([{ type: SIGNAL.ACTIVITY }], state).state.status, STATUS.COOKING, 'it is not settled');
}

function testReviveLeavesDone() {
  const done = run([{ type: SIGNAL.TURN_START }, { type: SIGNAL.TURN_COMPLETE }]).state;
  assert.strictEqual(run([{ type: SIGNAL.ACTIVITY }], done).state.status, STATUS.DONE, 'plain late activity keeps Done');
  assert.strictEqual(run([{ type: SIGNAL.ACTIVITY, revive: true }], done).state.status, STATUS.COOKING, 'revive activity leaves Done');
  assert.strictEqual(run([{ type: SIGNAL.ACTIVITY, revive: 'yes' }], done).state.status, STATUS.DONE, 'revive must be exactly true');
}

function testTerminalStatesResistLateEvents() {
  for (const terminal of [SIGNAL.TURN_COMPLETE, SIGNAL.FAILURE]) {
    const { state } = run([
      { type: SIGNAL.TURN_START },
      { type: SIGNAL.REQUEST_OPEN, requestId: 'r1' },
      { type: terminal },
      { type: SIGNAL.ACTIVITY },
      { type: SIGNAL.REQUEST_CLOSE, requestId: 'r1' },
      { type: SIGNAL.REQUEST_CLOSE },
      { type: terminal },
    ]);
    assert.strictEqual(state.status, terminal === SIGNAL.TURN_COMPLETE ? STATUS.DONE : STATUS.BURN, `${terminal} survives late events`);
    assert.deepStrictEqual(state.lifecycle.pending, {}, 'the turn ending clears waiting requests');
  }
  const next = run([{ type: SIGNAL.TURN_COMPLETE }, { type: SIGNAL.TURN_START }]).state;
  assert.strictEqual(next.status, STATUS.COOKING, 'a new turn leaves Done');
}

function testRequestsAreNotHiddenByActivity() {
  const { trace } = run([
    { type: SIGNAL.TURN_START },
    { type: SIGNAL.REQUEST_OPEN, requestId: 'r1', reason: 'permission:Bash' },
    { type: SIGNAL.ACTIVITY },
    { type: SIGNAL.REQUEST_OPEN, requestId: 'r2', reason: 'permission:Edit' },
    { type: SIGNAL.REQUEST_CLOSE, requestId: 'r1' },
    { type: SIGNAL.ACTIVITY },
    { type: SIGNAL.REQUEST_CLOSE, requestId: 'r2' },
    { type: SIGNAL.ACTIVITY, reason: 'tool:Read' },
  ]);
  assert.deepStrictEqual(trace.map(s => s.status), [
    STATUS.COOKING, STATUS.YOUR_TURN, STATUS.YOUR_TURN, STATUS.YOUR_TURN,
    STATUS.YOUR_TURN, STATUS.YOUR_TURN, STATUS.COOKING, STATUS.COOKING,
  ]);
  assert.strictEqual(trace[1].reason, 'permission:Bash');
  assert.strictEqual(trace[4].reason, 'permission:Edit', 'the remaining request is shown');
}

function testDuplicateAndReorderedRequests() {
  // Duplicate opening event after the request was resolved: not reopened.
  const dup = run([
    { type: SIGNAL.TURN_START },
    { type: SIGNAL.REQUEST_OPEN, requestId: 'r1' },
    { type: SIGNAL.REQUEST_CLOSE, requestId: 'r1' },
    { type: SIGNAL.REQUEST_OPEN, requestId: 'r1' },
  ]).state;
  assert.strictEqual(dup.status, STATUS.COOKING);
  // Resolution delivered before the request: the late request is ignored.
  const reordered = run([
    { type: SIGNAL.TURN_START },
    { type: SIGNAL.REQUEST_CLOSE, requestId: 'r9' },
    { type: SIGNAL.REQUEST_OPEN, requestId: 'r9' },
  ]).state;
  assert.strictEqual(reordered.status, STATUS.COOKING);
  // Resolving an unknown request changes no status.
  const unknownClose = run([
    { type: SIGNAL.TURN_START },
    { type: SIGNAL.REQUEST_OPEN, requestId: 'r1' },
    { type: SIGNAL.REQUEST_CLOSE, requestId: 'other' },
  ]).state;
  assert.strictEqual(unknownClose.status, STATUS.YOUR_TURN);
  // The same signal twice gives the same record (apart from the time).
  const once = run([{ type: SIGNAL.TURN_START }, { type: SIGNAL.REQUEST_OPEN, requestId: 'r1' }]).state;
  const twice = run([{ type: SIGNAL.TURN_START }, { type: SIGNAL.REQUEST_OPEN, requestId: 'r1' }, { type: SIGNAL.REQUEST_OPEN, requestId: 'r1' }]).state;
  assert.deepStrictEqual({ ...once, updated_at: 0 }, { ...twice, updated_at: 0 });
  // Bounded bookkeeping.
  const many = run([{ type: SIGNAL.TURN_START }, ...Array.from({ length: 100 }, (_, i) => ({ type: SIGNAL.REQUEST_CLOSE, requestId: `c${i}` }))]).state;
  assert.ok(many.lifecycle.closed.length <= 32, 'resolved-request memory is bounded');
}

function testSubagentsNeverSettleTheParent() {
  for (const type of [SIGNAL.TURN_COMPLETE, SIGNAL.TURN_END, SIGNAL.FAILURE, SIGNAL.CANCEL, SIGNAL.SESSION_END]) {
    const { state } = run([{ type: SIGNAL.TURN_START }, { type, subagent: true }]);
    assert.strictEqual(state.status, STATUS.COOKING, `a subagent ${type} leaves the parent Cooking`);
    assert.ok(!state.deleted);
  }
  const child = run([{ type: SIGNAL.TURN_START, parentSessionId: 'parent-1' }]).state;
  assert.strictEqual(child.parent_session_id, 'parent-1', 'parent identity is kept');
  assert.strictEqual(run([{ type: SIGNAL.ACTIVITY }], child).state.parent_session_id, 'parent-1');
}

function testSessionEndNeverCompletes() {
  for (const before of [[], [{ type: SIGNAL.TURN_START }], [{ type: SIGNAL.REQUEST_OPEN, requestId: 'r' }]]) {
    const { state } = run([...before, { type: SIGNAL.SESSION_END }]);
    assert.notStrictEqual(state.status, STATUS.DONE);
  }
  const ended = reduceSession(run([{ type: SIGNAL.TURN_START }]).state, { type: SIGNAL.SESSION_END, sessionId: SID }, ctx());
  assert.deepStrictEqual(Object.keys(ended).sort(), ['agent', 'deleted', 'session_id', 'updated_at']);
  assert.strictEqual(ended.status, undefined, 'session end removes the session; it is never Done');
}

function testSessionsAreIsolated() {
  const a = reduceSession(null, { type: SIGNAL.TURN_START, sessionId: 'a' }, ctx());
  assert.strictEqual(reduceSession(a, { type: SIGNAL.TURN_COMPLETE, sessionId: 'b' }, ctx()), null,
    'a signal for another session never changes this record');
}

function testShouldPersist() {
  const a = reduceSession(null, { type: SIGNAL.TURN_START, sessionId: SID }, ctx(1000));
  const same = reduceSession(a, { type: SIGNAL.ACTIVITY, sessionId: SID, reason: 'prompt submitted' }, ctx(2000));
  assert.strictEqual(shouldPersist(a, same), false, 'unchanged state is not rewritten');
  const later = reduceSession(a, { type: SIGNAL.ACTIVITY, sessionId: SID, reason: 'prompt submitted' }, ctx(1000 + HEARTBEAT_MS));
  assert.strictEqual(shouldPersist(a, later), true, 'heartbeat keeps an active session fresh');
  assert.strictEqual(shouldPersist(null, a), true);
  assert.strictEqual(shouldPersist(a, null), false);
}

function run_() {
  testValidation();
  testTurnLifecycle();
  testFailureAndCancel();
  testTurnEndWithoutOutcome();
  testReviveLeavesDone();
  testTerminalStatesResistLateEvents();
  testRequestsAreNotHiddenByActivity();
  testDuplicateAndReorderedRequests();
  testSubagentsNeverSettleTheParent();
  testSessionEndNeverCompletes();
  testSessionsAreIsolated();
  testShouldPersist();
  console.log('All LetItCook lifecycle contract tests passed.');
}

run_();
