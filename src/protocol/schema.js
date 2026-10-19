// LetItCook event protocol, schema 1 (docs/protocol.md): validation of one event and its
// mapping to the shared lifecycle signals (src/core/lifecycle.js). Pure: no I/O.
//
// An event is accepted whole or rejected whole. Errors are short codes that never echo
// the event's values, so diagnostics cannot leak what a producer sent.

import { SIGNAL, CAPABILITY } from '../core/lifecycle.js';
import { isValidSessionId } from '../core/fs-safe.js';

export const PROTOCOL_SCHEMA = 1;
export const MAX_EVENT_BYTES = 16 * 1024;
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_EVENT_SKEW_MS = 5 * 60 * 1000;

const AGENT_RE = /^[a-z][a-z0-9-]{1,31}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
// Known and future event types alike: lower-case dotted identifiers.
const TYPE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_CWD = 4096;

// Agent ids of native adapters (and generic names) cannot be used by producers, so a
// producer never shows up as, or writes the files of, a native integration.
export const RESERVED_AGENTS = new Set([
  'opencode', 'copilot', 'claude', 'codex', 'gemini', 'goose', 'unknown', 'agent', 'event', 'letitcook',
]);

export const EVENT_TYPES = Object.freeze([
  'session.started', 'turn.started', 'activity', 'request.opened', 'request.resolved',
  'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.ended', 'session.ended',
  'subagent.started', 'subagent.stopped',
]);
const KNOWN_TYPES = new Set(EVENT_TYPES);
const REQUEST_KINDS = new Set(['permission', 'question', 'input']);
const REQUEST_OUTCOMES = new Set(['approved', 'denied', 'answered', 'cancelled']);
const CAPABILITIES = new Set(Object.values(CAPABILITY));

function isLabel(value) {
  return typeof value === 'string' && LABEL_RE.test(value);
}

// Returns { ok: true, event } for a valid event, { ok: true, ignored: code } for a valid
// envelope with an unknown type (forward compatibility), or { ok: false, error: code }.
export function validateEvent(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'not_an_object' };
  if (raw.schema !== PROTOCOL_SCHEMA) return { ok: false, error: 'unsupported_schema' };
  if (typeof raw.agent !== 'string' || !AGENT_RE.test(raw.agent)) return { ok: false, error: 'invalid_agent' };
  if (RESERVED_AGENTS.has(raw.agent)) return { ok: false, error: 'reserved_agent' };
  if (!isValidSessionId(raw.session_id)) return { ok: false, error: 'invalid_session_id' };
  if (typeof raw.event_id !== 'string' || !ID_RE.test(raw.event_id)) return { ok: false, error: 'invalid_event_id' };
  if (typeof raw.type !== 'string' || !TYPE_RE.test(raw.type)) return { ok: false, error: 'invalid_type' };
  if (!Number.isSafeInteger(raw.time) || raw.time <= 0) return { ok: false, error: 'invalid_time' };
  if (raw.time < now - MAX_EVENT_AGE_MS) return { ok: false, error: 'stale_time' };
  if (raw.time > now + MAX_EVENT_SKEW_MS) return { ok: false, error: 'future_time' };

  const event = {
    agent: raw.agent,
    session_id: raw.session_id,
    event_id: raw.event_id,
    type: raw.type,
    time: raw.time,
  };
  for (const key of ['turn_id', 'request_id']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || !ID_RE.test(raw[key])) return { ok: false, error: `invalid_${key}` };
    event[key] = raw[key];
  }
  for (const key of ['subject', 'error_code', 'subagent_id']) {
    if (raw[key] === undefined) continue;
    if (!isLabel(raw[key])) return { ok: false, error: `invalid_${key}` };
    event[key] = raw[key];
  }
  if (raw.parent_session_id !== undefined) {
    if (!isValidSessionId(raw.parent_session_id) || raw.parent_session_id === raw.session_id) {
      return { ok: false, error: 'invalid_parent_session_id' };
    }
    event.parent_session_id = raw.parent_session_id;
  }
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string' || !raw.cwd.startsWith('/') || raw.cwd.length > MAX_CWD ||
        /[\u0000-\u001f\u007f]/.test(raw.cwd)) {
      return { ok: false, error: 'invalid_cwd' };
    }
    event.cwd = raw.cwd;
  }
  if (raw.kind !== undefined) {
    if (!REQUEST_KINDS.has(raw.kind)) return { ok: false, error: 'invalid_kind' };
    event.kind = raw.kind;
  }
  if (raw.outcome !== undefined) {
    if (!REQUEST_OUTCOMES.has(raw.outcome)) return { ok: false, error: 'invalid_outcome' };
    event.outcome = raw.outcome;
  }
  if (raw.capabilities !== undefined) {
    const caps = raw.capabilities;
    if (!Array.isArray(caps) || caps.length > CAPABILITIES.size || !caps.every(c => CAPABILITIES.has(c))) {
      return { ok: false, error: 'invalid_capabilities' };
    }
    event.capabilities = [...new Set(caps)].sort();
  }
  if (raw.pid !== undefined) {
    if (!Number.isSafeInteger(raw.pid) || raw.pid <= 1) return { ok: false, error: 'invalid_pid' };
    event.pid = raw.pid;
  }

  if (!KNOWN_TYPES.has(event.type)) return { ok: true, ignored: 'unknown_type', event };
  if (event.type.startsWith('request.') && !event.request_id) return { ok: false, error: 'missing_request_id' };
  return { ok: true, event };
}

// Name of a protocol session's state file. The `@` prefix cannot start a native adapter's
// file (session ids and agent ids never contain it).
export function protocolFileName(agent, sessionId) {
  return `@${agent}.${sessionId}.json`;
}

// Maps a validated event to lifecycle signals.
export function eventToSignals(event) {
  const base = {
    sessionId: event.session_id,
    eventId: event.event_id,
    at: event.time,
  };
  if (event.turn_id) base.turnId = event.turn_id;
  if (event.cwd) base.cwd = event.cwd;
  if (event.parent_session_id) base.parentSessionId = event.parent_session_id;
  if (event.subagent_id) base.subagent = true;
  const declares = event.capabilities && (event.type === 'session.started' || event.type === 'turn.started')
    ? { capabilities: event.capabilities }
    : {};
  const about = event.subject ? `:${event.subject}` : '';

  switch (event.type) {
    case 'session.started':
      return [{ ...base, ...declares, type: SIGNAL.METADATA }];
    case 'turn.started':
      return [{ ...base, ...declares, type: SIGNAL.TURN_START, reason: 'turn started' }];
    case 'activity':
      return [{ ...base, type: SIGNAL.ACTIVITY, reason: `working${about}` }];
    case 'request.opened':
      return [{ ...base, type: SIGNAL.REQUEST_OPEN, requestId: event.request_id, reason: `${event.kind || 'permission'}${about}` }];
    case 'request.resolved':
      return [{ ...base, type: SIGNAL.REQUEST_CLOSE, requestId: event.request_id, reason: 'request resolved' }];
    case 'turn.completed':
      return [{ ...base, type: SIGNAL.TURN_COMPLETE, reason: 'turn completed' }];
    case 'turn.failed':
      return [{ ...base, type: SIGNAL.FAILURE, reason: `error:${event.error_code || 'failed'}` }];
    case 'turn.cancelled':
      return [{ ...base, type: SIGNAL.CANCEL, reason: 'cancelled' }];
    case 'turn.ended':
      return [{ ...base, type: SIGNAL.TURN_END, reason: 'turn ended' }];
    case 'session.ended':
      return [{ ...base, type: SIGNAL.SESSION_END }];
    case 'subagent.started':
    case 'subagent.stopped':
      return [{ ...base, type: SIGNAL.ACTIVITY, reason: 'subagent', subagent: true }];
    default:
      return [];
  }
}

export default {
  PROTOCOL_SCHEMA, MAX_EVENT_BYTES, RESERVED_AGENTS, EVENT_TYPES,
  validateEvent, protocolFileName, eventToSignals,
};
