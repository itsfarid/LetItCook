import assert from 'node:assert';
import { SIGNAL, CAPABILITY, validateSignal, reduceSession, shouldPersist, HEARTBEAT_MS } from '../src/core/lifecycle.js';
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
  // Non-unique ids: an identical later request is shown again when resolutions are not remembered.
  const reused = run([
    { type: SIGNAL.TURN_START },
    { type: SIGNAL.REQUEST_OPEN, requestId: 'perm:Bash:abc' },
    { type: SIGNAL.REQUEST_CLOSE, requestId: 'perm:Bash:abc', remember: false },
    { type: SIGNAL.REQUEST_OPEN, requestId: 'perm:Bash:abc' },
  ]).state;
  assert.strictEqual(reused.status, STATUS.YOUR_TURN, 'an identical later request is not suppressed');
  assert.deepStrictEqual(reused.lifecycle.closed, []);
  // Bounded bookkeeping.
  const many = run([{ type: SIGNAL.TURN_START }, ...Array.from({ length: 100 }, (_, i) => ({ type: SIGNAL.REQUEST_CLOSE, requestId: `c${i}` }))]).state;
  assert.ok(many.lifecycle.closed.length <= 32, 'resolved-request memory is bounded');
}

// Optional ordering metadata (event ids, turn ids, producer times) used by the generic
// protocol. Native adapters do not send it and are unaffected.
function testEventOrderingMetadata() {
  // Duplicate event ids are ignored, also for state-changing events.
  const dup = run([
    { type: SIGNAL.TURN_START, eventId: 'e1', turnId: 't1', at: 100 },
    { type: SIGNAL.TURN_COMPLETE, eventId: 'e2', turnId: 't1', at: 200 },
    { type: SIGNAL.TURN_START, eventId: 'e3', turnId: 't2', at: 300 },
    { type: SIGNAL.TURN_COMPLETE, eventId: 'e2', turnId: 't2', at: 400 },
  ]).state;
  assert.strictEqual(dup.status, STATUS.COOKING, 'a replayed event id does not complete the new turn');

  // A completion of the previous turn arriving late does not complete the current one.
  const lateTurn = run([
    { type: SIGNAL.TURN_START, eventId: 'a', turnId: 't1', at: 100 },
    { type: SIGNAL.TURN_START, eventId: 'b', turnId: 't2', at: 300 },
    { type: SIGNAL.TURN_COMPLETE, eventId: 'c', turnId: 't1', at: 200 },
    { type: SIGNAL.FAILURE, eventId: 'd', turnId: 't1', at: 250 },
    { type: SIGNAL.REQUEST_OPEN, eventId: 'e', turnId: 't1', requestId: 'r-old' },
  ]).state;
  assert.strictEqual(lateTurn.status, STATUS.COOKING, 'late outcome and request of turn t1 are ignored');
  assert.strictEqual(lateTurn.lifecycle.turn, 't2');

  // Without turn ids, producer times still order turn starts and endings.
  const lateStart = run([
    { type: SIGNAL.TURN_START, eventId: 'a', at: 100 },
    { type: SIGNAL.TURN_COMPLETE, eventId: 'b', at: 300 },
    { type: SIGNAL.TURN_START, eventId: 'c', at: 200 },
  ]).state;
  assert.strictEqual(lateStart.status, STATUS.DONE, 'a turn start older than the completion does not reopen the turn');

  // Requests and activity are not dropped for being older (parallel hooks).
  const parallel = run([
    { type: SIGNAL.TURN_START, eventId: 'a', turnId: 't1', at: 100 },
    { type: SIGNAL.ACTIVITY, eventId: 'b', at: 300 },
    { type: SIGNAL.REQUEST_OPEN, eventId: 'c', turnId: 't1', requestId: 'r1', at: 200 },
  ]).state;
  assert.strictEqual(parallel.status, STATUS.YOUR_TURN, 'an older request of the current turn still shows');

  // Invalid metadata rejects the signal; absent metadata is fine.
  for (const bad of [{ eventId: '../x' }, { eventId: 7 }, { turnId: '' }, { at: -1 }, { at: 1.5 }, { at: '100' }]) {
    assert.strictEqual(reduceSession(null, { type: SIGNAL.TURN_START, sessionId: SID, ...bad }, ctx()), null, `rejects ${JSON.stringify(bad)}`);
  }

  // Bounded memory of applied ids.
  const many = run(Array.from({ length: 200 }, (_, i) => ({ type: SIGNAL.ACTIVITY, eventId: `e${i}` }))).state;
  assert.ok(many.lifecycle.seen.length <= 64);

  // Recording an applied id alone is not worth a write.
  const a = reduceSession(null, { type: SIGNAL.TURN_START, sessionId: SID, eventId: 'x1' }, ctx(1000));
  const b = reduceSession(a, { type: SIGNAL.ACTIVITY, sessionId: SID, eventId: 'x2', reason: 'prompt submitted' }, ctx(2000));
  assert.strictEqual(shouldPersist(a, b), false);
}

function testCapabilities() {
  // A producer that cannot tell success from failure declares neither and ends turns
  // without outcome; a stray completion is not trusted.
  const limited = run([
    { type: SIGNAL.TURN_START, capabilities: [CAPABILITY.REQUESTS] },
    { type: SIGNAL.TURN_COMPLETE },
    { type: SIGNAL.FAILURE },
    { type: SIGNAL.CANCEL },
  ]).state;
  assert.strictEqual(limited.status, STATUS.COOKING, 'undeclared outcomes are ignored');
  assert.deepStrictEqual(limited.capabilities, ['requests']);
  assert.strictEqual(run([{ type: SIGNAL.TURN_END }], limited).state.status, STATUS.YOUR_TURN, 'turn end is always allowed');
  const noRequests = run([{ type: SIGNAL.TURN_START, capabilities: [CAPABILITY.COMPLETE] }, { type: SIGNAL.REQUEST_OPEN, requestId: 'r' }]).state;
  assert.strictEqual(noRequests.status, STATUS.COOKING, 'requests need the requests capability');

  // A later declaration replaces the earlier one; metadata never changes the status.
  const declared = run([{ type: SIGNAL.TURN_START }, { type: SIGNAL.METADATA, capabilities: ['complete', 'fail', 'complete'], cwd: '/w' }]).state;
  assert.strictEqual(declared.status, STATUS.COOKING);
  assert.deepStrictEqual(declared.capabilities, ['complete', 'fail'], 'deduplicated and sorted');
  assert.strictEqual(declared.cwd, '/w');
  assert.strictEqual(run([{ type: SIGNAL.TURN_COMPLETE }], declared).state.status, STATUS.DONE);
  assert.strictEqual(reduceSession(null, { type: SIGNAL.METADATA, sessionId: SID, capabilities: [] }, ctx()), null, 'metadata alone creates no session');

  // Without a declaration nothing is restricted (native adapters).
  assert.strictEqual(run([{ type: SIGNAL.TURN_START }, { type: SIGNAL.TURN_COMPLETE }]).state.status, STATUS.DONE);
  assert.ok(!('capabilities' in run([{ type: SIGNAL.TURN_START }]).state));

  for (const bad of ['complete', ['done'], [1], ['requests', 'complete', 'fail', 'cancel', 'requests']]) {
    assert.strictEqual(validateSignal({ type: SIGNAL.TURN_START, sessionId: SID, capabilities: bad }), null, `rejects ${JSON.stringify(bad)}`);
  }
}

// Request ids are producer data: inherited object member names must be ordinary keys
// (Devin review on PR #7).
function testPrototypeSensitiveRequestIds() {
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const waiting = run([{ type: SIGNAL.TURN_START }, { type: SIGNAL.REQUEST_OPEN, requestId: id, reason: 'permission:x' }, { type: SIGNAL.ACTIVITY }]).state;
    assert.strictEqual(waiting.status, STATUS.YOUR_TURN, `${id}: still waiting after activity`);
    assert.deepStrictEqual(Object.keys(waiting.lifecycle.pending), [id], `${id}: recorded as an own entry`);
    // It survives the state file (JSON) and is resolved by its own id only.
    const reloaded = JSON.parse(JSON.stringify(waiting));
    assert.strictEqual(run([{ type: SIGNAL.ACTIVITY }], reloaded).state.status, STATUS.YOUR_TURN, `${id}: still waiting after a reload`);
    assert.strictEqual(run([{ type: SIGNAL.REQUEST_CLOSE, requestId: id }], reloaded).state.status, STATUS.COOKING, `${id}: resolved by its id`);
    // Resolving an inherited name that is not waiting changes nothing.
    const cancelled = run([{ type: SIGNAL.TURN_START }, { type: SIGNAL.CANCEL }, { type: SIGNAL.REQUEST_CLOSE, requestId: id }]).state;
    assert.strictEqual(cancelled.status, STATUS.YOUR_TURN, `${id}: an unknown resolution is not taken for a waiting one`);
  }
  // A crafted state file cannot inject non-string entries.
  const crafted = { session_id: SID, agent: 'test', status: STATUS.YOUR_TURN, lifecycle: { pending: { a: 'permission:x', b: { evil: 1 } }, closed: [] } };
  assert.deepStrictEqual(Object.keys(run([{ type: SIGNAL.ACTIVITY }], crafted).state.lifecycle.pending), ['a']);
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
  testEventOrderingMetadata();
  testCapabilities();
  testPrototypeSensitiveRequestIds();
  testSubagentsNeverSettleTheParent();
  testSessionEndNeverCompletes();
  testSessionsAreIsolated();
  testShouldPersist();
  console.log('All LetItCook lifecycle contract tests passed.');
}

run_();
