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
  return path.join(os.homedir(), '.local', 'state', 'letitcook', 'sessions');
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
    Boolean(prev.deleted) !== Boolean(next.deleted)
  );
}

export function extractSessionId(event) {
  if (!event) return 'global';
  const p = event.properties || {};
  return p.sessionID || p.sessionId || (p.session && p.session.id) || (p.info && p.info.id) || 'global';
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
  if (!event || !event.type) return null;

  const sessionId = extractSessionId(event);
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
    case 'question.rejected': {
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
      status = STATUS.UNKNOWN;
      reason = 'session.idle:status unknown';
      break;
    }
    case 'session.compacted': {
      status = previousState ? previousState.status : STATUS.UNKNOWN;
      reason = event.type;
      break;
    }
    case 'message.updated': {
      const role = p.role || (p.info && p.info.role);
      if (role === 'assistant') {
        status = STATUS.COOKING;
        reason = 'assistant working';
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
      const st = String(p.status || p.state || '').toLowerCase();
      if (/wait|permission|ask|approval|blocked/.test(st)) {
        status = STATUS.YOUR_TURN;
      } else if (/busy|work|run|active|processing|retry|pending|streaming/.test(st)) {
        status = STATUS.COOKING;
      } else if (/done|complete|finish/.test(st)) {
        status = STATUS.DONE;
      } else if (/error|fail|burn|aborted/.test(st)) {
        status = STATUS.BURN;
      }
      reason = `status:${st}`;
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
    agent: 'opencode',
    status,
    reason,
    title,
    cwd,
    pid,
    created_at: createdAt,
    updated_at: now,
  };
}

export function mapToolHook(stage, input, previousState = null) {
  const sessionId = (input && (input.sessionID || input.sessionId)) || (previousState ? previousState.session_id : 'global');
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
  };
}

export function writeSessionFile(session, baseDir) {
  const sessionId = assertValidSessionId(session && session.session_id);
  const targetDir = getSessionDir(baseDir);
  ensurePrivateDir(targetDir);

  const filePath = path.join(targetDir, `${sessionId}.json`);
  const tmpPath = path.join(targetDir, `.${sessionId}.${process.pid}.${Date.now()}.tmp`);

  // ponytail: atomic rename on POSIX, upgrade to lockfile if cross-device issues occur
  fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), 'utf8');
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

export function readAllSessionsFromDir(baseDir, options = {}) {
  const targetDir = getSessionDir(baseDir);
  if (!fs.existsSync(targetDir)) return [];

  const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  const sessions = [];

  for (const file of files) {
    const fullPath = path.join(targetDir, file);
    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !isValidSessionId(parsed.session_id)) {
        throw new Error('invalid session id in state file');
      }
      const normalized = normalizeSession(parsed, options);
      if (normalized.terminated) {
        deleteSessionFile(normalized.session_id, baseDir);
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
