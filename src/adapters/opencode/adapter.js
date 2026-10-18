import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATUS, normalizeSession } from '../../core/status.js';
import { BaseAdapter } from '../base.js';
import { isValidSessionId, assertValidSessionId, ensurePrivateDir } from '../../core/fs-safe.js';

let writeCounter = 0;

export function getSessionDir(overrideDir) {
  if (overrideDir) return overrideDir;
  if (process.env.LETITCOOK_STATE_DIR) return process.env.LETITCOOK_STATE_DIR;
  // Match GLib.get_user_state_dir() used by the GNOME extension.
  const xdgState = process.env.XDG_STATE_HOME;
  const stateHome = xdgState && path.isAbsolute(xdgState) ? xdgState : path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'letitcook', 'sessions');
}

export function getWriteCount() {
  return writeCounter;
}

export function resetWriteCount() {
  writeCounter = 0;
}

export function hasMeaningfulStateChange(prev, next) {
  if (!prev && next) return true;
  if (prev && !next) return true;
  if (!prev && !next) return false;
  return (
    prev.status !== next.status ||
    prev.reason !== next.reason ||
    prev.title !== next.title ||
    prev.cwd !== next.cwd ||
    prev.pid !== next.pid ||
    Boolean(prev.deleted) !== Boolean(next.deleted) ||
    prev._completionCandidate !== next._completionCandidate ||
    prev._lastUserMessageId !== next._lastUserMessageId ||
    JSON.stringify(prev._toolMessageIds || []) !== JSON.stringify(next._toolMessageIds || []) ||
    JSON.stringify(prev._pendingRequests || {}) !== JSON.stringify(next._pendingRequests || {}) ||
    prev._completionMessageId !== next._completionMessageId
  );
}

const REQUEST_ASKED = new Set(['permission.asked', 'permission.v2.asked', 'question.asked', 'question.v2.asked']);
const REQUEST_ANSWERED = new Set([
  'permission.replied', 'permission.v2.replied',
  'question.replied', 'question.v2.replied', 'question.rejected', 'question.v2.rejected',
]);

function isIdleStatusEvent(event, p) {
  return event.type === 'session.status' && String((p.status || {}).type || p.status || '').toLowerCase() === 'idle';
}

// Permission/question requests still awaiting the user, keyed by request id. Answering
// one of several parallel requests must not hide the others. The agent loop ending
// (idle or error) clears them so a missed reply can never pin Your Turn.
function nextPendingRequests(event, p, previous, reason) {
  if (event.type === 'session.idle' || event.type === 'session.error' || isIdleStatusEvent(event, p)) return {};
  const pending = { ...(previous || {}) };
  if (REQUEST_ASKED.has(event.type) && typeof p.id === 'string' && p.id) {
    pending[p.id] = reason;
  } else if (REQUEST_ANSWERED.has(event.type) && typeof p.requestID === 'string') {
    delete pending[p.requestID];
  }
  return pending;
}

function applyPendingRequests(status, reason, pending) {
  const ids = Object.keys(pending);
  if (ids.length === 0 || status !== STATUS.COOKING) return { status, reason };
  return { status: STATUS.YOUR_TURN, reason: pending[ids[ids.length - 1]] };
}

export function extractSessionId(event) {
  if (!event || typeof event.type !== 'string') return null;
  const p = event.properties || {};
  return p.sessionID || p.sessionId || (p.session && p.session.id) || (p.info && p.info.sessionID) ||
    (p.part && p.part.sessionID) || (event.type.startsWith('session.') && p.info && p.info.id) || null;
}

export function extractCwd(event) {
  if (!event) return '';
  const p = event.properties || {};
  return p.directory || p.cwd || (p.info && p.info.directory) || (p.session && p.session.directory) || '';
}

export function extractTitle(event) {
  if (!event) return '';
  const p = event.properties || {};
  return p.title || (p.info && p.info.title) || (p.session && p.session.title) || '';
}

export function mapOpenCodeEvent(event, previousState = null) {
  if (!event || typeof event.type !== 'string' || !event.type) return null;

  const sessionId = extractSessionId(event) || (previousState ? previousState.session_id : null);
  if (!sessionId || sessionId === 'global') return null;

  const cwd = extractCwd(event) || (previousState ? previousState.cwd : '');
  const title = extractTitle(event) || (previousState ? previousState.title : '');
  const pid = (event.pid && Number.isInteger(event.pid)) ? event.pid : (previousState ? previousState.pid : process.pid);
  const now = Date.now();
  const createdAt = previousState ? previousState.created_at : now;
  const p = event.properties || {};

  if (event.type === 'session.deleted') {
    return {
      session_id: sessionId,
      agent: 'opencode',
      deleted: true,
      updated_at: now,
    };
  }

  let status = null;
  let reason = '';

  switch (event.type) {
    case 'permission.asked':
    case 'permission.v2.asked':
    case 'question.asked':
    case 'question.v2.asked': {
      status = STATUS.YOUR_TURN;
      const perm = p.permission || p.action || p.question || p.header || 'permission requested';
      const pat = Array.isArray(p.patterns || p.resources) ? (p.patterns || p.resources).slice(0, 2).join(',') : '';
      reason = pat ? `${event.type}:${perm}:${pat}` : `${event.type}:${perm}`;
      break;
    }
    case 'permission.replied':
    case 'permission.v2.replied':
    case 'question.replied':
    case 'question.v2.replied':
    case 'question.rejected':
    case 'question.v2.rejected': {
      status = STATUS.COOKING;
      reason = `${event.type}:${p.reply || p.action || 'replied'}`;
      break;
    }
    case 'session.created': {
      status = STATUS.COOKING;
      reason = 'session.created';
      break;
    }
    case 'session.updated': {
      status = previousState ? previousState.status : STATUS.COOKING;
      reason = previousState ? previousState.reason : 'session.updated';
      break;
    }
    case 'session.error': {
      status = STATUS.BURN;
      const err = p.error || p.err || {};
      const msg = err.data?.message || err.message || String(err.name || 'session error');
      reason = `error:${msg}`;
      break;
    }
    case 'session.idle': {
      if (previousState?.status === STATUS.DONE || previousState?.status === STATUS.BURN) {
        status = previousState.status;
        reason = previousState.reason;
      } else if (previousState?._completionCandidate) {
        status = STATUS.DONE;
        reason = 'assistant completed successfully';
      } else {
        status = STATUS.UNKNOWN;
        reason = 'session.idle:status unknown';
      }
      break;
    }
    case 'session.compacted': {
      status = previousState ? previousState.status : STATUS.UNKNOWN;
      reason = event.type;
      break;
    }
    case 'message.part.updated': {
      status = previousState ? previousState.status : STATUS.UNKNOWN;
      reason = previousState ? previousState.reason : `unhandled event: ${event.type}`;
      break;
    }
    case 'message.updated': {
      const info = p.info || p;
      if (info.role === 'user') {
        const isNewUserMessage = (typeof info.id === 'string' && Boolean(info.id))
          ? info.id !== previousState?._lastUserMessageId
          : !previousState?._lastUserMessageId;
        if (isNewUserMessage) {
          status = STATUS.COOKING;
          reason = 'user message received';
        } else {
          status = previousState ? previousState.status : STATUS.COOKING;
          reason = previousState ? previousState.reason : 'user message updated';
        }
      } else if (info.role === 'assistant' && previousState?.status === STATUS.DONE &&
                 typeof info.id === 'string' && info.id === previousState._completionMessageId) {
        // A late or duplicate update of the message that completed the turn keeps Done.
        status = previousState.status;
        reason = previousState.reason;
      } else if (info.role === 'assistant') {
        const toolMessageIds = previousState?._toolMessageIds || [];
        const completedAt = info.time?.completed;
        const finish = info.finish;
        const hasCompletionEvidence =
          Number.isFinite(completedAt) && completedAt > 0 &&
          typeof finish === 'string' && finish.length > 0 &&
          finish !== 'tool-calls' && finish !== 'unknown' &&
          !info.error && info.summary !== true &&
          !toolMessageIds.includes(info.id) &&
          typeof previousState?._lastUserMessageId === 'string' &&
          info.parentID === previousState._lastUserMessageId;
        status = STATUS.COOKING;
        reason = hasCompletionEvidence ? 'assistant completion awaiting idle' : 'assistant working';
      }
      break;
    }
    case 'session.next.step.started':
    case 'session.next.tool.called': {
      status = STATUS.COOKING;
      reason = `tool:${p.tool || 'active'}`;
      break;
    }
    case 'session.status': {
      const rawStatus = p.status || p.state || '';
      const st = String(typeof rawStatus === 'object' ? rawStatus.type || '' : rawStatus).toLowerCase();
      if (st === 'idle' && previousState?._completionCandidate) {
        status = STATUS.DONE;
        reason = 'assistant completed successfully';
      } else if (/wait|permission|ask|approval|blocked/.test(st)) {
        status = STATUS.YOUR_TURN;
      } else if (/busy|work|run|active|processing|retry|pending|streaming/.test(st)) {
        status = STATUS.COOKING;
      } else if (/done|complete|finish/.test(st)) {
        status = STATUS.DONE;
      } else if (/error|fail|burn|aborted/.test(st)) {
        status = STATUS.BURN;
      }
      reason = reason || `status:${st}`;
      break;
    }
    default:
      break;
  }

  if (!status) {
    if (previousState) {
      status = previousState.status;
      reason = previousState.reason;
    } else {
      status = STATUS.UNKNOWN;
      reason = `unhandled event: ${event.type}`;
    }
  }

  const pendingRequests = nextPendingRequests(event, p, previousState?._pendingRequests, reason);
  ({ status, reason } = applyPendingRequests(status, reason, pendingRequests));

  const info = p.info || p;
  let lastUserMessageId = previousState?._lastUserMessageId;
  let toolMessageIds = previousState?._toolMessageIds || [];
  let completionCandidate = false;
  let completionMessageId = previousState?._completionMessageId;

  const isNewUserMessage = event.type === 'message.updated' && info.role === 'user' &&
    ((typeof info.id === 'string' && Boolean(info.id))
      ? info.id !== previousState?._lastUserMessageId
      : !previousState?._lastUserMessageId);

  if (isNewUserMessage) {
    lastUserMessageId = info.id;
    toolMessageIds = [];
    completionCandidate = false;
    completionMessageId = undefined;
  } else if (event.type === 'message.part.updated' && p.part?.type === 'tool' && typeof p.part.messageID === 'string') {
    toolMessageIds = [...new Set([...toolMessageIds, p.part.messageID])];
    completionCandidate = false;
  } else if (event.type === 'message.updated' && info.role === 'assistant') {
    const completedAt = info.time?.completed;
    const finish = info.finish;
    completionCandidate = status !== STATUS.DONE &&
      Number.isFinite(completedAt) && completedAt > 0 &&
      typeof finish === 'string' && finish.length > 0 &&
      finish !== 'tool-calls' && finish !== 'unknown' &&
      !info.error && info.summary !== true &&
      !toolMessageIds.includes(info.id) &&
      typeof lastUserMessageId === 'string' && info.parentID === lastUserMessageId;
    if (completionCandidate) completionMessageId = info.id;
  } else if (isIdleStatusEvent(event, p)) {
    completionCandidate = false;
  } else if (status === STATUS.DONE || status === STATUS.BURN || status === STATUS.YOUR_TURN) {
    completionCandidate = false;
  } else if (previousState?._completionCandidate && status === STATUS.COOKING) {
    completionCandidate = true;
  }

  return {
    session_id: sessionId,
    agent: 'opencode',
    status,
    reason,
    title,
    cwd,
    pid,
    created_at: createdAt,
    updated_at: now,
    _lastUserMessageId: lastUserMessageId,
    _toolMessageIds: toolMessageIds,
    _completionCandidate: completionCandidate,
    _completionMessageId: completionMessageId,
    _pendingRequests: pendingRequests,
  };
}

export function mapToolHook(stage, input, previousState = null) {
  const sessionId = (input && (input.sessionID || input.sessionId)) || (previousState ? previousState.session_id : null);
  if (!sessionId || sessionId === 'global') return null;
  const tool = (input && input.tool) || 'unknown';
  const isQuestion = /question|ask|input|prompt|confirm/i.test(tool);
  const now = Date.now();
  const createdAt = previousState ? previousState.created_at : now;
  const cwd = (input && input.cwd) || (previousState ? previousState.cwd : '');
  const title = (input && input.title) || (previousState ? previousState.title : '');
  const pid = (previousState && previousState.pid) || process.pid;

  let status = STATUS.COOKING;
  let reason = `tool:${tool}`;

  if (stage === 'before') {
    status = isQuestion ? STATUS.YOUR_TURN : STATUS.COOKING;
    reason = `tool:${tool}:executing`;
  } else if (stage === 'after') {
    status = STATUS.COOKING;
    reason = `tool:${tool}:completed`;
  }

  const pendingRequests = previousState?._pendingRequests || {};
  ({ status, reason } = applyPendingRequests(status, reason, pendingRequests));

  return {
    session_id: sessionId,
    agent: 'opencode',
    status,
    reason,
    title,
    cwd,
    pid,
    created_at: createdAt,
    updated_at: now,
    _lastUserMessageId: previousState?._lastUserMessageId,
    _toolMessageIds: previousState?._toolMessageIds || [],
    _completionCandidate: false,
    _completionMessageId: previousState?._completionMessageId,
    _pendingRequests: pendingRequests,
  };
}

export function writeSessionFile(session, baseDir) {
  const sessionId = assertValidSessionId(session && session.session_id);
  const targetDir = getSessionDir(baseDir);
  ensurePrivateDir(targetDir);

  const filePath = path.join(targetDir, `${sessionId}.json`);
  const tmpPath = path.join(targetDir, `.${sessionId}.${process.pid}.${Date.now()}.tmp`);

  // Completion bookkeeping is process-local and must not leak into the normalized state file.
  const { _lastUserMessageId, _toolMessageIds, _completionCandidate, _completionMessageId, _pendingRequests, ...persistedSession } = session;
  // ponytail: atomic rename on POSIX, upgrade to lockfile if cross-device issues occur
  fs.writeFileSync(tmpPath, JSON.stringify(persistedSession, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  writeCounter++;
}

export function deleteSessionFile(sessionId, baseDir) {
  if (!isValidSessionId(sessionId)) return;
  const targetDir = getSessionDir(baseDir);
  const filePath = path.join(targetDir, `${sessionId}.json`);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

// Removes exactly the file that was read, and only if it is still that file: a file
// rewritten since it was read (new state from a live agent) is kept.
function removeIfUnchanged(filePath, readStat) {
  try {
    const now = fs.lstatSync(filePath);
    if (now.isFile() && now.dev === readStat.dev && now.ino === readStat.ino &&
        now.size === readStat.size && now.mtimeMs === readStat.mtimeMs) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

// Reads every session file in the state directory. Terminated sessions are pruned (their
// own file is removed) unless `options.prune === false`, which read-only callers such as
// the notification inspection CLI use. Symlinks and other non-regular files are skipped:
// the writers only ever create regular files.
export function readAllSessionsFromDir(baseDir, options = {}) {
  const targetDir = getSessionDir(baseDir);
  if (!fs.existsSync(targetDir)) return [];
  const prune = options.prune !== false;

  const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  const sessions = [];

  for (const file of files) {
    const fullPath = path.join(targetDir, file);
    let stat;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !isValidSessionId(parsed.session_id)) {
        throw new Error('invalid session id in state file');
      }
      const normalized = normalizeSession(parsed, options);
      if (normalized.terminated) {
        if (prune) removeIfUnchanged(fullPath, stat);
      } else {
        sessions.push(normalized);
      }
    } catch {
      const stem = file.replace(/\.json$/, '');
      if (!isValidSessionId(stem)) continue;
      const fallback = normalizeSession({
        session_id: stem,
        agent: 'opencode',
        status: STATUS.UNKNOWN,
        reason: 'corrupted state file',
      }, options);
      if (!fallback.terminated) {
        sessions.push(fallback);
      }
    }
  }

  return sessions;
}

export class OpenCodeAdapter extends BaseAdapter {
  constructor() {
    super('opencode', 'OpenCode');
  }

  isAvailable() {
    if (typeof process !== 'undefined' && process.env.OPENCODE_BIN) return true;
    const home = os.homedir();
    if (fs.existsSync(path.join(home, '.opencode'))) return true;
    if (process.env.PATH) {
      const parts = process.env.PATH.split(path.delimiter);
      for (const p of parts) {
        if (fs.existsSync(path.join(p, 'opencode'))) return true;
      }
    }
    return false;
  }

  detectSessions(options = {}) {
    const dir = options.baseDir || getSessionDir();
    return readAllSessionsFromDir(dir, options).filter(s => s.agent === this.id);
  }

  getSessionState(sessionId, options = {}) {
    if (!isValidSessionId(sessionId)) return null;
    const dir = options.baseDir || getSessionDir();
    const filePath = path.join(dir, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return this.normalizeState(raw, options);
    } catch {
      return this.normalizeState({ session_id: sessionId, status: STATUS.UNKNOWN, reason: 'unreadable' }, options);
    }
  }
}

export default {
  getSessionDir,
  getWriteCount,
  resetWriteCount,
  hasMeaningfulStateChange,
  extractSessionId,
  extractCwd,
  extractTitle,
  mapOpenCodeEvent,
  mapToolHook,
  writeSessionFile,
  deleteSessionFile,
  readAllSessionsFromDir,
  OpenCodeAdapter,
};
