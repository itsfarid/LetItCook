import assert from 'node:assert';
import {
  PROTOCOL_SCHEMA, RESERVED_AGENTS, EVENT_TYPES, validateEvent, protocolFileName, eventToSignals,
} from '../src/protocol/schema.js';
import { SIGNAL, reduceSession } from '../src/core/lifecycle.js';
import { STATUS } from '../src/core/status.js';

const NOW = 1_800_000_000_000;
let counter = 0;
export function protocolEvent(type, extra = {}) {
  return { schema: 1, agent: 'mycli', session_id: 'sess-1', event_id: `e${++counter}`, type, time: NOW, ...extra };
}
const check = (raw) => validateEvent(raw, { now: NOW });

function testValidEnvelope() {
  const result = check(protocolEvent('turn.started', { turn_id: 't1', cwd: '/work', capabilities: ['fail', 'complete', 'fail'], extra: 'ignored' }));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.ignored, undefined);
  assert.deepStrictEqual(result.event.capabilities, ['complete', 'fail'], 'deduplicated and sorted');
  assert.ok(!('extra' in result.event), 'unknown fields are dropped, never stored');
  assert.strictEqual(PROTOCOL_SCHEMA, 1);
}

function testRejectedEnvelopes() {
  const cases = {
    not_an_object: [null, [], 'x', 42],
    unsupported_schema: [protocolEvent('activity', { schema: 2 }), protocolEvent('activity', { schema: '1' }), { ...protocolEvent('activity'), schema: undefined }],
    invalid_agent: [protocolEvent('activity', { agent: 'My CLI' }), protocolEvent('activity', { agent: 'x' }), protocolEvent('activity', { agent: '../x' }), protocolEvent('activity', { agent: undefined })],
    reserved_agent: [...RESERVED_AGENTS].map(agent => protocolEvent('activity', { agent })),
    invalid_session_id: [protocolEvent('activity', { session_id: '../etc' }), protocolEvent('activity', { session_id: '.hidden' }), protocolEvent('activity', { session_id: 'a/b' }), protocolEvent('activity', { session_id: 7 })],
    invalid_event_id: [protocolEvent('activity', { event_id: '' }), protocolEvent('activity', { event_id: 'a b' }), protocolEvent('activity', { event_id: 'x'.repeat(200) })],
    invalid_type: [protocolEvent(''), protocolEvent(7), protocolEvent('Turn Started'), protocolEvent('turn.started; rm')],
    invalid_time: [protocolEvent('activity', { time: '2026-01-01' }), protocolEvent('activity', { time: 1.5 }), protocolEvent('activity', { time: -1 })],
    stale_time: [protocolEvent('activity', { time: NOW - 25 * 60 * 60 * 1000 })],
    future_time: [protocolEvent('activity', { time: NOW + 10 * 60 * 1000 })],
    invalid_turn_id: [protocolEvent('activity', { turn_id: '$(x)' })],
    invalid_request_id: [protocolEvent('request.opened', { request_id: '' })],
    missing_request_id: [protocolEvent('request.opened'), protocolEvent('request.resolved')],
    invalid_subject: [protocolEvent('activity', { subject: 'rm -rf /' }), protocolEvent('activity', { subject: 'x'.repeat(65) })],
    invalid_error_code: [protocolEvent('turn.failed', { error_code: 'quota exceeded; secret=abc' })],
    invalid_subagent_id: [protocolEvent('activity', { subagent_id: {} })],
    invalid_parent_session_id: [protocolEvent('activity', { parent_session_id: '../p' }), protocolEvent('activity', { parent_session_id: 'sess-1' })],
    invalid_cwd: [protocolEvent('activity', { cwd: 'relative' }), protocolEvent('activity', { cwd: '/a\nb' }), protocolEvent('activity', { cwd: `/${'x'.repeat(5000)}` })],
    invalid_kind: [protocolEvent('request.opened', { request_id: 'r', kind: 'exec' })],
    invalid_outcome: [protocolEvent('request.resolved', { request_id: 'r', outcome: 'maybe' })],
    invalid_capabilities: [protocolEvent('turn.started', { capabilities: 'complete' }), protocolEvent('turn.started', { capabilities: ['done'] })],
    invalid_pid: [protocolEvent('activity', { pid: 1 }), protocolEvent('activity', { pid: '42' })],
  };
  for (const [error, events] of Object.entries(cases)) {
    for (const raw of events) {
      const result = check(raw);
      assert.deepStrictEqual(result, { ok: false, error }, `${error}: ${JSON.stringify(raw)?.slice(0, 80)}`);
    }
  }
}

function testErrorsNeverEchoValues() {
  const secret = 'sk-SECRET-IN-EVENT-0123456789';
  for (const raw of [protocolEvent('activity', { subject: secret + ' x' }), protocolEvent('turn.failed', { error_code: `${secret}!` }), protocolEvent(secret + ' ')]) {
    assert.ok(!JSON.stringify(check(raw)).includes(secret));
  }
}

function testUnknownTypesAreIgnored() {
  const result = check(protocolEvent('turn.paused'));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.ignored, 'unknown_type');
  assert.deepStrictEqual(eventToSignals(result.event), [], 'no signal for an unknown type');
}

function testMapping() {
  const map = (type, extra) => eventToSignals(check(protocolEvent(type, extra)).event);
  const expected = {
    'session.started': SIGNAL.METADATA,
    'turn.started': SIGNAL.TURN_START,
    activity: SIGNAL.ACTIVITY,
    'request.opened': SIGNAL.REQUEST_OPEN,
    'request.resolved': SIGNAL.REQUEST_CLOSE,
    'turn.completed': SIGNAL.TURN_COMPLETE,
    'turn.failed': SIGNAL.FAILURE,
    'turn.cancelled': SIGNAL.CANCEL,
    'turn.ended': SIGNAL.TURN_END,
    'session.ended': SIGNAL.SESSION_END,
    'subagent.started': SIGNAL.ACTIVITY,
    'subagent.stopped': SIGNAL.ACTIVITY,
  };
  assert.deepStrictEqual(Object.keys(expected).sort(), [...EVENT_TYPES].sort(), 'every event type is mapped');
  for (const [type, signal] of Object.entries(expected)) {
    const [s] = map(type, { request_id: 'r1', turn_id: 't1' });
    assert.strictEqual(s.type, signal, type);
    assert.strictEqual(s.sessionId, 'sess-1');
    assert.strictEqual(s.at, NOW);
    assert.strictEqual(s.turnId, 't1');
    assert.ok(s.eventId);
  }
  assert.strictEqual(map('request.opened', { request_id: 'r', kind: 'question' })[0].reason, 'question');
  assert.strictEqual(map('request.opened', { request_id: 'r', subject: 'shell' })[0].reason, 'permission:shell');
  assert.strictEqual(map('turn.failed', { error_code: 'rate_limit' })[0].reason, 'error:rate_limit');
  assert.strictEqual(map('subagent.stopped')[0].subagent, true);
  assert.strictEqual(map('turn.completed', { subagent_id: 'sub-1' })[0].subagent, true, 'any subagent event is subagent activity');
  assert.deepStrictEqual(map('turn.started', { capabilities: ['complete'] })[0].capabilities, ['complete']);
  assert.strictEqual(map('activity', { capabilities: ['complete'] })[0].capabilities, undefined, 'only session.started and turn.started declare');
  assert.strictEqual(protocolFileName('mycli', 'sess-1'), '@mycli.sess-1.json');
}

// Through the shared reducer: the protocol produces the same states as native adapters.
function testEndToEndThroughReducer() {
  let state = null;
  const apply = (type, extra) => {
    for (const s of eventToSignals(check(protocolEvent(type, extra)).event)) {
      const next = reduceSession(state, s, { agent: 'mycli', now: NOW });
      if (next) state = next;
    }
    return state && (state.deleted ? 'removed' : state.status);
  };
  assert.strictEqual(apply('turn.started', { turn_id: 't1', capabilities: ['requests', 'complete', 'fail', 'cancel'] }), STATUS.COOKING);
  assert.strictEqual(apply('request.opened', { turn_id: 't1', request_id: 'p1', subject: 'shell' }), STATUS.YOUR_TURN);
  assert.strictEqual(apply('activity'), STATUS.YOUR_TURN, 'activity does not hide the request');
  assert.strictEqual(apply('request.resolved', { request_id: 'p1', outcome: 'approved' }), STATUS.COOKING);
  assert.strictEqual(apply('turn.completed', { turn_id: 't1' }), STATUS.DONE);
  assert.strictEqual(apply('turn.started', { turn_id: 't2' }), STATUS.COOKING);
  assert.strictEqual(apply('turn.completed', { turn_id: 't1' }), STATUS.COOKING, 'a late completion of t1 is ignored');
  assert.strictEqual(apply('turn.failed', { turn_id: 't2', error_code: 'quota' }), STATUS.BURN);
  assert.strictEqual(apply('session.ended'), 'removed');
}

// Event ids of events that change nothing are not written to the state file. Re-applying
// such an event later (a duplicate) must still change nothing, whatever happened between.
function testUnpersistedDuplicatesStayHarmless() {
  const apply = (state, type, extra) => {
    for (const s of eventToSignals(check(protocolEvent(type, extra)).event)) {
      const next = reduceSession(state, s, { agent: 'mycli', now: NOW });
      if (next) state = next;
    }
    return state;
  };
  const activity = protocolEvent('activity', { event_id: 'dup-activity' });
  const dupApply = state => {
    let out = state;
    for (const s of eventToSignals(check(activity).event)) {
      const next = reduceSession(out, s, { agent: 'mycli', now: NOW });
      if (next) out = next;
    }
    return out;
  };
  let state = apply(null, 'turn.started', { turn_id: 't1' });
  state = dupApply(state);
  // The duplicate arrives after the session settled, or while a request waits.
  const done = apply(state, 'turn.completed', { turn_id: 't1' });
  assert.strictEqual(dupApply({ ...done, lifecycle: { ...done.lifecycle, seen: [] } }).status, STATUS.DONE);
  const waiting = apply(state, 'request.opened', { turn_id: 't1', request_id: 'r1' });
  assert.strictEqual(dupApply({ ...waiting, lifecycle: { ...waiting.lifecycle, seen: [] } }).status, STATUS.YOUR_TURN);
}

function run() {
  testValidEnvelope();
  testRejectedEnvelopes();
  testErrorsNeverEchoValues();
  testUnknownTypesAreIgnored();
  testMapping();
  testEndToEndThroughReducer();
  testUnpersistedDuplicatesStayHarmless();
  console.log('All LetItCook event protocol tests passed.');
}

run();
