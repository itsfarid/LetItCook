// Shared lifecycle contract for event-driven (hook-based) adapters.
//
// An adapter translates each provider event into zero or more normalized signals
// (`SIGNAL`), and `reduceSession` turns signals into the existing session-file schema
// (see normalizeSession in status.js). Adapters never set a status themselves, so the
// rules below hold for every provider:
//
// - Done only on an explicit TURN_COMPLETE from the main agent, never from a session
//   ending, a process exiting or silence.
// - Burn only on an explicit FAILURE from the main agent.
// - A waiting request (permission or question) keeps the session at Your Turn until that
//   request is resolved or the turn ends; other activity does not hide it.
// - Done and Burn only change on a new turn (TURN_START) or a new request: late tool
//   activity cannot regress them, unless the adapter marks it `revive` (activity that
//   can only happen when the agent really continues, e.g. another stop hook made it
//   continue its turn).
// - Subagent signals are activity of their parent session: a subagent finishing or
//   failing never completes or burns the parent.
// - Duplicates are idempotent, and a request resolved earlier is not reopened by a late
//   duplicate of its opening event. Adapters whose request ids are not unique (derived
//   from the tool call, so an identical later call reuses the id) and whose provider
//   runs hooks synchronously, so a resolution cannot precede its request, resolve with
//   `remember: false`.

import { STATUS } from './status.js';
import { isValidSessionId } from './fs-safe.js';

export const SIGNAL = Object.freeze({
  TURN_START: 'turn_start', // the user submitted a prompt
  ACTIVITY: 'activity', // reliable evidence of work (tool or model activity)
  REQUEST_OPEN: 'request_open', // the agent waits for a permission or an answer
  REQUEST_CLOSE: 'request_close', // a waiting request was resolved
  TURN_COMPLETE: 'turn_complete', // documented successful end of the turn
  TURN_END: 'turn_end', // the turn ended without a reported outcome: the agent waits for the user
  FAILURE: 'failure', // documented failure of the turn
  CANCEL: 'cancel', // the user interrupted the turn; the agent waits for the user
  SESSION_END: 'session_end', // the session ended; its state file is removed
});

const SIGNAL_TYPES = new Set(Object.values(SIGNAL));
const MAX_REASON = 120;
const MAX_TITLE = 200;
const MAX_CWD = 4096;
const MAX_REQUEST_ID = 128;
const MAX_PENDING = 32;
const MAX_CLOSED = 32;
const MAX_SEEN = 64;
// Event and turn ids (optional; sent by the generic protocol, not by native adapters).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TURN_ENDING = [SIGNAL.TURN_COMPLETE, SIGNAL.TURN_END, SIGNAL.FAILURE, SIGNAL.CANCEL];

// Same rate limit as the OpenCode plugin: a session whose state did not change is
// rewritten at most this often while it is active, to prove it is still alive.
export const HEARTBEAT_MS = 60 * 1000;

function boundedString(value, max) {
  if (typeof value !== 'string') return '';
  // Control characters never belong in reasons, titles or paths.
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

// Validates a signal at the adapter boundary. Returns a clean copy, or null when the
// signal is malformed or unsupported (it is then ignored, never guessed at).
export function validateSignal(signal) {
  if (!signal || typeof signal !== 'object') return null;
  if (!SIGNAL_TYPES.has(signal.type)) return null;
  if (!isValidSessionId(signal.sessionId)) return null;
  const clean = {
    type: signal.type,
    sessionId: signal.sessionId,
    subagent: signal.subagent === true,
    revive: signal.revive === true,
    remember: signal.remember !== false,
    reason: boundedString(signal.reason, MAX_REASON),
    title: boundedString(signal.title, MAX_TITLE),
    cwd: boundedString(signal.cwd, MAX_CWD),
    requestId: boundedString(signal.requestId, MAX_REQUEST_ID),
  };
  if (signal.parentSessionId !== undefined) {
    if (!isValidSessionId(signal.parentSessionId)) return null;
    clean.parentSessionId = signal.parentSessionId;
  }
  // Optional ordering metadata: present but invalid rejects the signal.
  for (const key of ['eventId', 'turnId']) {
    if (signal[key] === undefined) continue;
    if (typeof signal[key] !== 'string' || !ID_RE.test(signal[key])) return null;
    clean[key] = signal[key];
  }
  if (signal.at !== undefined) {
    if (!Number.isSafeInteger(signal.at) || signal.at <= 0) return null;
    clean.at = signal.at;
  }
  return clean;
}

function closedWith(closed, id) {
  if (!id) return closed;
  return [...closed.filter(x => x !== id), id].slice(-MAX_CLOSED);
}

function withoutRequest(pending, id) {
  if (!id) return {};
  const next = { ...pending };
  delete next[id];
  return next;
}

// Applies one validated signal to the previous session record (or null). Returns the
// next record, `{ session_id, agent, deleted: true }` when the session ended, or null
// when the signal changes nothing.
export function reduceSession(prev, signal, context = {}) {
  const s = validateSignal(signal);
  if (!s) return null;
  if (prev && prev.session_id !== s.sessionId) return null;
  const agent = context.agent || (prev && prev.agent) || 'unknown';
  const now = Number.isFinite(context.now) ? context.now : Date.now();

  if (s.type === SIGNAL.SESSION_END) {
    return s.subagent ? null : { session_id: s.sessionId, agent, deleted: true, updated_at: now };
  }

  const lifecycle = (prev && prev.lifecycle) || {};
  let pending = { ...(lifecycle.pending || {}) };
  let closed = Array.isArray(lifecycle.closed) ? lifecycle.closed.slice(-MAX_CLOSED) : [];
  const seen = Array.isArray(lifecycle.seen) ? lifecycle.seen.slice(-MAX_SEEN) : [];
  let turn = typeof lifecycle.turn === 'string' ? lifecycle.turn : undefined;
  let turnAt = Number.isSafeInteger(lifecycle.turnAt) ? lifecycle.turnAt : undefined;
  let status = prev ? prev.status : null;
  let reason = prev ? prev.reason : '';
  const settled = status === STATUS.DONE || status === STATUS.BURN;

  // A subagent's end of turn, failure or cancellation is activity of its parent.
  const type = s.subagent && TURN_ENDING.includes(s.type) ? SIGNAL.ACTIVITY : s.type;
  const turnLevel = type === SIGNAL.TURN_START || TURN_ENDING.includes(type);

  // Ordering (only for signals that carry ids or times):
  // - an event id already applied is a duplicate;
  // - a turn-ending event or a request for another turn than the current one is late;
  // - a turn start or end older than the last applied one is late.
  if (s.eventId && seen.includes(s.eventId)) return null;
  if (s.turnId && turn && s.turnId !== turn && (TURN_ENDING.includes(type) || type === SIGNAL.REQUEST_OPEN)) return null;
  if (turnLevel && s.at && turnAt && s.at < turnAt) return null;
  if (turnLevel) {
    if (type === SIGNAL.TURN_START) turn = s.turnId;
    if (s.at) turnAt = s.at;
  }

  switch (type) {
    case SIGNAL.TURN_START:
      pending = {};
      status = STATUS.COOKING;
      reason = s.reason || 'prompt submitted';
      break;
    case SIGNAL.ACTIVITY:
      if (settled && !s.revive) return null;
      if (Object.keys(pending).length === 0) {
        status = STATUS.COOKING;
        reason = s.reason || 'working';
      }
      break;
    case SIGNAL.REQUEST_OPEN: {
      const id = s.requestId || 'request';
      if (closed.includes(id)) return null;
      if (!(id in pending) && Object.keys(pending).length >= MAX_PENDING) return null;
      pending[id] = s.reason || 'waiting for you';
      status = STATUS.YOUR_TURN;
      reason = pending[id];
      break;
    }
    case SIGNAL.REQUEST_CLOSE: {
      if (settled) return null;
      if (s.remember) closed = closedWith(closed, s.requestId);
      // Resolving a request that is not waiting (unknown, or a duplicate) changes no status.
      if (s.requestId && !(s.requestId in pending)) {
        if (!prev) return null;
        break;
      }
      pending = withoutRequest(pending, s.requestId);
      const ids = Object.keys(pending);
      if (ids.length > 0) {
        status = STATUS.YOUR_TURN;
        reason = pending[ids[ids.length - 1]];
      } else {
        status = STATUS.COOKING;
        reason = s.reason || 'request answered';
      }
      break;
    }
    case SIGNAL.TURN_COMPLETE:
      pending = {};
      status = STATUS.DONE;
      reason = s.reason || 'turn completed';
      break;
    case SIGNAL.TURN_END:
      pending = {};
      status = STATUS.YOUR_TURN;
      reason = s.reason || 'turn ended';
      break;
    case SIGNAL.FAILURE:
      pending = {};
      status = STATUS.BURN;
      reason = s.reason || 'failed';
      break;
    case SIGNAL.CANCEL:
      pending = {};
      status = STATUS.YOUR_TURN;
      reason = s.reason || 'cancelled';
      break;
    default:
      return null;
  }

  const record = {
    session_id: s.sessionId,
    agent,
    status,
    reason,
    title: s.title || (prev && prev.title) || '',
    cwd: s.cwd || (prev && prev.cwd) || '',
    pid: Number.isInteger(context.pid) ? context.pid : (prev && Number.isInteger(prev.pid) ? prev.pid : null),
    created_at: prev && Number.isFinite(prev.created_at) ? prev.created_at : now,
    updated_at: now,
    confidence: 'high',
    lifecycle: { pending, closed },
  };
  if (s.eventId) record.lifecycle.seen = [...seen, s.eventId].slice(-MAX_SEEN);
  else if (seen.length) record.lifecycle.seen = seen;
  if (turn) record.lifecycle.turn = turn;
  if (turnAt) record.lifecycle.turnAt = turnAt;
  const parent = s.parentSessionId || (prev && prev.parent_session_id);
  if (parent) record.parent_session_id = parent;
  return record;
}

// True when `next` differs from `prev` in anything a reader shows or the reducer uses,
// or when an active session's heartbeat is due.
export function shouldPersist(prev, next, heartbeatMs = HEARTBEAT_MS) {
  if (!next) return false;
  if (!prev || next.deleted) return true;
  const fields = ['status', 'reason', 'title', 'cwd', 'pid', 'parent_session_id'];
  if (fields.some(f => prev[f] !== next[f])) return true;
  // The record of applied event ids alone is not worth a write: re-applying an event whose
  // id was not persisted changes nothing (it was a no-op or idempotent activity).
  const bookkeeping = ({ seen, ...rest } = {}) => JSON.stringify(rest);
  if (bookkeeping(prev.lifecycle) !== bookkeeping(next.lifecycle)) return true;
  const active = next.status === STATUS.COOKING || next.status === STATUS.YOUR_TURN;
  return active && !(next.updated_at - prev.updated_at < heartbeatMs);
}

export default { SIGNAL, HEARTBEAT_MS, validateSignal, reduceSession, shouldPersist };
