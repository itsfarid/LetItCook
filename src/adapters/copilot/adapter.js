import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATUS, normalizeSession, isValidStatus } from '../../core/status.js';
import { BaseAdapter } from '../base.js';
import { isValidSessionId, ensurePrivateDir } from '../../core/fs-safe.js';

export function getCopilotStateDir(overrideDir) {
  if (overrideDir) return overrideDir;
  if (process.env.LETITCOOK_COPILOT_DIR) return process.env.LETITCOOK_COPILOT_DIR;
  return path.join(os.homedir(), '.copilot');
}

export function parseWorkspaceYaml(content) {
  if (!content || typeof content !== 'string') return {};
  const result = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (match) {
      const key = match[1];
      let val = match[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }

  return result;
}

export function mapCopilotEvent(event, previousState = null) {
  if (!event || !event.type) return null;

  const data = event.data || {};
  const timestamp = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
  const sessionId = data.sessionId || (previousState ? previousState.session_id : 'global');
  const cwd = (data.context && data.context.cwd) || (previousState ? previousState.cwd : '');
  const title = (previousState ? previousState.title : '') || '';
  const now = Number.isNaN(timestamp) ? Date.now() : timestamp;
  const createdAt = previousState ? previousState.created_at : now;

  let status = null;
  let reason = '';
  let terminated = false;
  let deleted = false;

  switch (event.type) {
    case 'session.start':
    case 'session.resume': {
      status = STATUS.COOKING;
      reason = event.type;
      break;
    }
    case 'assistant.turn_start':
    case 'model.turn_started':
    case 'model.model_call_started': {
      status = STATUS.COOKING;
      reason = 'turn:started';
      break;
    }
    case 'tool.execution_start': {
      const toolName = data.toolName || data.name || (data.tool && data.tool.name) || '';
      if (/ask_user|confirm|prompt|question/i.test(toolName)) {
        status = STATUS.YOUR_TURN;
        reason = `tool:${toolName}`;
      } else {
        status = STATUS.COOKING;
        reason = toolName ? `tool:${toolName}` : 'tool:executing';
      }
      break;
    }
    case 'tool.execution_complete':
    case 'tool.execution_partial_result':
    case 'tool.execution_progress': {
      status = STATUS.COOKING;
      const toolName = data.toolName || data.name || 'tool';
      reason = `tool:${toolName}:complete`;
      break;
    }
    case 'permission.requested': {
      status = STATUS.YOUR_TURN;
      const permReq = data.permissionRequest || {};
      const kind = permReq.kind || data.kind || 'permission';
      const intention = permReq.intention || data.intention || '';
      reason = intention ? `permission:${kind}:${intention}` : `permission:${kind}`;
      break;
    }
    case 'permission.completed': {
      status = STATUS.COOKING;
      reason = 'permission:completed';
      break;
    }
    case 'user_input.requested': {
      status = STATUS.YOUR_TURN;
      const q = data.question || 'input requested';
      reason = `input:${q.slice(0, 50)}`;
      break;
    }
    case 'user_input.completed': {
      status = STATUS.COOKING;
      reason = 'input:completed';
      break;
    }
    case 'elicitation.requested': {
      status = STATUS.YOUR_TURN;
      const msg = data.message || data.elicitationSource || 'elicitation';
      reason = `elicitation:${msg.slice(0, 50)}`;
      break;
    }
    case 'elicitation.completed': {
      status = STATUS.COOKING;
      reason = 'elicitation:completed';
      break;
    }
    case 'assistant.message': {
      const toolReqs = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      const hasAsk = toolReqs.some(t => /ask_user|confirm|question/i.test(t.name || ''));
      if (hasAsk) {
        status = STATUS.YOUR_TURN;
        reason = 'ask_user';
      } else if (toolReqs.length > 0) {
        status = STATUS.COOKING;
        reason = `tools:${toolReqs.length}`;
      } else {
        status = STATUS.COOKING;
        reason = 'assistant response';
      }
      break;
    }
    case 'assistant.turn_end': {
      status = STATUS.YOUR_TURN;
      reason = 'turn:ended:awaiting input';
      break;
    }
    case 'session.task_complete': {
      const success = data.success !== false;
      status = success ? STATUS.DONE : STATUS.BURN;
      const summary = data.summary || (success ? 'task completed' : 'task failed');
      reason = summary.slice(0, 80);
      break;
    }
    case 'session.error': {
      status = STATUS.BURN;
      const errType = data.errorType || 'error';
      const msg = data.message || 'session error';
      reason = `error:${errType}:${msg.slice(0, 80)}`;
      break;
    }
    case 'abort': {
      const abortReason = String(data.reason || '').toLowerCase();
      if (/user/i.test(abortReason)) {
        status = STATUS.YOUR_TURN;
        reason = 'abort:user initiated';
      } else if (/error|fail|exception/i.test(abortReason)) {
        status = STATUS.BURN;
        reason = `abort:error:${data.reason || 'unknown'}`;
      } else {
        status = STATUS.UNKNOWN;
        reason = `abort:${data.reason || 'unknown'}`;
      }
      break;
    }
    case 'session.shutdown': {
      terminated = true;
      const prevStatus = previousState ? previousState.status : null;
      if (prevStatus === STATUS.DONE || prevStatus === STATUS.BURN) {
        status = prevStatus;
      } else {
        const shutdownType = data.shutdownType || '';
        const errorReason = data.errorReason || '';
        if (errorReason || shutdownType === 'error' || shutdownType === 'crash') {
          status = STATUS.BURN;
          reason = `shutdown:${shutdownType}:${errorReason || 'error'}`;
        } else {
          status = STATUS.UNKNOWN;
          reason = `shutdown:${shutdownType || 'routine'}`;
        }
      }
      break;
    }
    case 'session.idle': {
      const prevStatus = previousState ? previousState.status : null;
      if (prevStatus === STATUS.COOKING) {
        status = STATUS.UNKNOWN;
        reason = 'session.idle:no background agents';
      } else {
        return previousState
          ? { ...previousState, updated_at: now }
          : { session_id: sessionId, agent: 'copilot', status: STATUS.UNKNOWN, reason: 'session.idle', updated_at: now };
      }
      break;
    }
    case 'model.turn_ended':
    case 'model.model_call_success':
    case 'model.model_call_failure': {
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

  return {
    session_id: sessionId,
    agent: 'copilot',
    status,
    reason,
    title,
    cwd,
    pid: previousState ? previousState.pid : null,
    created_at: createdAt,
    updated_at: now,
    terminated,
    deleted,
    confidence: isValidStatus(status) && status !== STATUS.UNKNOWN ? 'high' : 'medium',
  };
}

// Replays a session directory into its raw (not yet normalized) state, together with the
// validated session id (events may carry a different, invalid one).
function replaySessionDir(sessionDirPath) {
  if (!fs.existsSync(sessionDirPath)) return null;

  const wsPath = path.join(sessionDirPath, 'workspace.yaml');
  const evPath = path.join(sessionDirPath, 'events.jsonl');

  let wsMeta = {};
  if (fs.existsSync(wsPath)) {
    try {
      wsMeta = parseWorkspaceYaml(fs.readFileSync(wsPath, 'utf8'));
    } catch {}
  }

  const candidates = [wsMeta.id, path.basename(sessionDirPath)];
  const sessionId = candidates.find(isValidSessionId);
  if (!sessionId) return null;
  const cwd = wsMeta.cwd || '';
  const title = wsMeta.name || wsMeta.summary || '';
  const createdAt = wsMeta.created_at ? new Date(wsMeta.created_at).getTime() : Date.now();
  const updatedAt = wsMeta.updated_at ? new Date(wsMeta.updated_at).getTime() : createdAt;

  let state = {
    session_id: sessionId,
    agent: 'copilot',
    status: STATUS.UNKNOWN,
    reason: 'initialized',
    title,
    cwd,
    pid: null,
    created_at: Number.isNaN(createdAt) ? Date.now() : createdAt,
    updated_at: Number.isNaN(updatedAt) ? Date.now() : updatedAt,
    stale: false,
    terminated: false,
    confidence: 'medium',
  };

  if (fs.existsSync(evPath)) {
    try {
      const content = fs.readFileSync(evPath, 'utf8').trim();
      if (content) {
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            const next = mapCopilotEvent(ev, state);
            if (next) {
              state = {
                ...next,
                title: title || next.title,
                cwd: cwd || next.cwd,
              };
            }
          } catch {}
        }
      }
    } catch {}
  }

  return { state, sessionId };
}

function normalizeReplayed(replayed, options) {
  const normalized = normalizeSession(replayed.state, options);
  if (!isValidSessionId(normalized.session_id)) {
    normalized.session_id = replayed.sessionId;
  }
  return normalized;
}

export function readSessionFromDir(sessionDirPath, options = {}) {
  const replayed = replaySessionDir(sessionDirPath);
  return replayed ? normalizeReplayed(replayed, options) : null;
}

// Identity of a session directory's inputs; replay is skipped while it is unchanged.
function sessionInputsKey(sessionDirPath) {
  const parts = [];
  for (const name of ['workspace.yaml', 'events.jsonl']) {
    try {
      const st = fs.statSync(path.join(sessionDirPath, name));
      parts.push(`${st.ino}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push('-');
    }
  }
  return parts.join('|');
}

export class CopilotAdapter extends BaseAdapter {
  constructor() {
    super('copilot', 'GitHub Copilot CLI');
    // session dir path -> { key, state }: replayed state of unchanged sessions is reused
    // between sync ticks; normalization (time-dependent staleness) still runs every tick.
    this._replayCache = new Map();
  }

  isAvailable() {
    if (typeof process !== 'undefined' && process.env.COPILOT_BIN) return true;
    const baseDir = getCopilotStateDir();
    if (fs.existsSync(baseDir)) return true;
    if (process.env.PATH) {
      const parts = process.env.PATH.split(path.delimiter);
      for (const p of parts) {
        if (fs.existsSync(path.join(p, 'copilot'))) return true;
      }
    }
    return false;
  }

  detectSessions(options = {}) {
    const baseDir = getCopilotStateDir(options.copilotDir);
    const sessionStateDir = path.join(baseDir, 'session-state');
    if (!fs.existsSync(sessionStateDir)) return [];

    const entries = fs.readdirSync(sessionStateDir).filter(f => !f.startsWith('.'));
    const sessions = [];
    const seen = new Set();

    for (const entry of entries) {
      const fullPath = path.join(sessionStateDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          seen.add(fullPath);
          const key = sessionInputsKey(fullPath);
          let cached = this._replayCache.get(fullPath);
          if (!cached || cached.key !== key) {
            cached = { key, replayed: replaySessionDir(fullPath) };
            this._replayCache.set(fullPath, cached);
          }
          const session = cached.replayed ? normalizeReplayed(cached.replayed, options) : null;
          if (session && !session.terminated) {
            sessions.push(session);
          }
        }
      } catch {}
    }
    for (const dir of this._replayCache.keys()) {
      if (!seen.has(dir)) this._replayCache.delete(dir);
    }

    return sessions;
  }

  getSessionState(sessionId, options = {}) {
    if (!isValidSessionId(sessionId)) return null;
    const baseDir = getCopilotStateDir(options.copilotDir);
    const sessionDir = path.join(baseDir, 'session-state', sessionId);
    if (!fs.existsSync(sessionDir)) return null;
    return readSessionFromDir(sessionDir, options);
  }

  syncToStateDir(targetStateDir, options = {}) {
    const sessions = this.detectSessions(options);
    ensurePrivateDir(targetStateDir);

    // Freshness policy: only sync sessions worth glancing at.
    // - stale sessions (too old to trust) are never written
    // - settled sessions (Done/Burn/Unknown) older than maxAgeMs are skipped
    //   so months-old history does not clog the panel menu forever
    const now = options.now || Date.now();
    const maxAgeMs = options.maxAgeMs || 60 * 60 * 1000;
    const live = sessions.filter(s => {
      if (!isValidSessionId(s.session_id)) return false;
      if (s.stale) return false;
      if (s.status !== STATUS.COOKING && s.status !== STATUS.YOUR_TURN) {
        return (now - s.updated_at) <= maxAgeMs;
      }
      return true;
    });

    // Track active copilot session files
    const activeFileNames = new Set();

    for (const session of live) {
      const fileName = `copilot_${session.session_id}.json`;
      activeFileNames.add(fileName);
      const filePath = path.join(targetStateDir, fileName);
      const tmpPath = path.join(targetStateDir, `.${fileName}.${process.pid}.${Date.now()}.tmp`);

      // ponytail: atomic rename on POSIX, upgrade to lockfile if cross-device issues occur
      fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpPath, filePath);
    }

    // Prune terminated copilot sessions from target directory
    try {
      const existingFiles = fs.readdirSync(targetStateDir).filter(f => f.startsWith('copilot_') && f.endsWith('.json'));
      for (const f of existingFiles) {
        if (!activeFileNames.has(f)) {
          try {
            fs.unlinkSync(path.join(targetStateDir, f));
          } catch {}
        }
      }
    } catch {}

    return live;
  }
}

export default {
  getCopilotStateDir,
  parseWorkspaceYaml,
  mapCopilotEvent,
  readSessionFromDir,
  CopilotAdapter,
};
