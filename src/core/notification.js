import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { STATUS } from './status.js';

const PRIVATE_FILE_MODE = 0o600;

function noFollowFlag() {
  const flag = fs.constants.O_NOFOLLOW;
  if (typeof flag !== 'number' || flag === 0) {
    throw new Error('Secure notification cache access requires O_NOFOLLOW');
  }
  return flag;
}

function statOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function ensurePrivateCacheDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Notification cache directory must be a real directory');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Notification cache directory is not owned by the current user');
  }

  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | noFollowFlag());
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('Notification cache directory changed while opening');
    }
    fs.fchmodSync(fd, 0o700);
  } finally {
    fs.closeSync(fd);
  }
}

function openCacheReadOnly(cachePath) {
  const dirStat = fs.lstatSync(path.dirname(cachePath));
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;

  const fd = fs.openSync(cachePath, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      fs.closeSync(fd);
      return null;
    }
    return fd;
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    throw error;
  }
}

function prepareExistingCache(cachePath) {
  const existing = statOrNull(cachePath);
  if (!existing) return null;
  if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
    throw new Error('Notification cache must be a standalone regular file, not a symlink or hard link');
  }
  if (typeof process.getuid === 'function' && existing.uid !== process.getuid()) {
    throw new Error('Notification cache is not owned by the current user');
  }

  const fd = fs.openSync(cachePath, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== existing.dev || opened.ino !== existing.ino) {
      throw new Error('Notification cache changed while opening');
    }
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    return { dev: opened.dev, ino: opened.ino };
  } finally {
    fs.closeSync(fd);
  }
}

export const NOTIFY_DEFAULTS = Object.freeze({
  notifyDone: false,
  suppressInitial: true,
});

export function shortCwd(cwd) {
  if (!cwd) return 'global';
  const home = os.homedir ? os.homedir() : '';
  let p = cwd;
  if (home && p.startsWith(home)) p = '~' + p.slice(home.length);
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return parts.slice(-2).join('/');
}

export function sanitizeText(str, maxLen = 120) {
  if (typeof str !== 'string') return '';
  const cleaned = str
    .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, '')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + '…';
}

export function shouldNotify(prevStatus, session, options = {}) {
  if (!session || typeof session !== 'object') {
    return { notify: false, reason: 'invalid_session' };
  }

  if (session.stale === true) {
    return { notify: false, reason: 'stale_session' };
  }

  if (session.confidence === 'low') {
    return { notify: false, reason: 'low_confidence' };
  }

  const curr = session.status;
  if (!curr || curr === STATUS.COOKING || curr === STATUS.UNKNOWN) {
    return { notify: false, reason: 'suppressed_status' };
  }

  if (curr === prevStatus) {
    return { notify: false, reason: 'no_status_change' };
  }

  if (curr === STATUS.YOUR_TURN) {
    return { notify: true, reason: 'your_turn', priority: 'high' };
  }

  if (curr === STATUS.BURN) {
    return { notify: true, reason: 'burn', priority: 'critical' };
  }

  if (curr === STATUS.DONE) {
    const notifyDone = options.notifyDone === true;
    if (!notifyDone) {
      return { notify: false, reason: 'done_opted_out' };
    }
    if (prevStatus !== STATUS.COOKING) {
      return { notify: false, reason: 'untrustworthy_done' };
    }
    return { notify: true, reason: 'done', priority: 'normal' };
  }

  return { notify: false, reason: 'unhandled_status' };
}

export function formatNotification(session) {
  const agent = sanitizeText(session?.agent || 'Agent', 32);
  const title = `LetItCook: ${agent}`;
  const status = session?.status;
  const reason = sanitizeText(session?.reason, 80);
  const subject = sanitizeText(session?.title || shortCwd(session?.cwd), 80);

  let body = '';
  if (status === STATUS.YOUR_TURN) {
    const prefix = 'Your Turn';
    const detail = reason ? `${prefix} (${reason})` : prefix;
    body = subject ? `${detail} • ${subject}` : detail;
  } else if (status === STATUS.BURN) {
    const prefix = 'Burn';
    const detail = reason ? `${prefix}: ${reason}` : prefix;
    body = subject ? `${detail} • ${subject}` : detail;
  } else if (status === STATUS.DONE) {
    body = subject ? `Done • ${subject}` : 'Done';
  } else {
    body = subject || 'Status updated';
  }

  return {
    title,
    body,
    urgency: status === STATUS.BURN ? 'critical' : (status === STATUS.YOUR_TURN ? 'high' : 'normal'),
  };
}

export class NotificationTracker {
  constructor(options = {}) {
    this.cachePath = options.cachePath || null;
    this.readOnly = options.readOnly === true;
    this.notifyDone = options.notifyDone === true;
    this.suppressInitial = options.suppressInitial !== false;
    this._isFirstScan = this.suppressInitial;
    this._cache = {
      _config: { notifyDone: this.notifyDone },
      sessions: {},
    };
    this._lastSavedJson = null;
    if (this.cachePath) {
      this.load(options);
    }
  }

  load(options = {}) {
    if (!this.cachePath) return;
    let fd = null;
    try {
      fd = openCacheReadOnly(this.cachePath);
      if (fd !== null) {
        const raw = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (raw && typeof raw === 'object') {
          if (options.notifyDone === undefined && raw._config && typeof raw._config.notifyDone === 'boolean') {
            this.notifyDone = raw._config.notifyDone;
          }
          if (raw.sessions && typeof raw.sessions === 'object') {
            this._cache.sessions = { ...raw.sessions };
          }
        }
      }
    } catch {
      this._cache = { _config: { notifyDone: this.notifyDone }, sessions: {} };
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
    this._cache._config = { notifyDone: this.notifyDone };
    this._lastSavedJson = JSON.stringify(this._cache, null, 2);
  }

  save(force = false) {
    if (!this.cachePath || this.readOnly) return false;
    let tmpPath = null;
    let fd = null;
    try {
      this._cache._config = { notifyDone: this.notifyDone };
      const serialized = JSON.stringify(this._cache, null, 2);
      const dir = path.dirname(this.cachePath);
      const unchanged = !force && serialized === this._lastSavedJson;
      if (unchanged && !statOrNull(this.cachePath)) {
        return false;
      }
      ensurePrivateCacheDirectory(dir);
      const existingIdentity = prepareExistingCache(this.cachePath);
      if (unchanged) {
        return false;
      }

      for (let attempt = 0; attempt < 5 && fd === null; attempt++) {
        tmpPath = path.join(dir, `.notify_cache.tmp.${process.pid}.${randomBytes(8).toString('hex')}`);
        try {
          fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(), PRIVATE_FILE_MODE);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          tmpPath = null;
        }
      }
      if (fd === null || tmpPath === null) throw new Error('Could not allocate a unique notification cache temp file');

      fs.fchmodSync(fd, PRIVATE_FILE_MODE);
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      // This identity recheck narrows accidental target races, but it is not an
      // atomic compare-and-rename. The private directory prevents other UIDs
      // from racing this path; concurrent same-UID writers remain a limitation.
      const current = statOrNull(this.cachePath);
      if (existingIdentity) {
        if (!current || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
            current.dev !== existingIdentity.dev || current.ino !== existingIdentity.ino) {
          throw new Error('Notification cache target changed before replacement');
        }
      } else if (current) {
        throw new Error('Notification cache target appeared before replacement');
      }

      fs.renameSync(tmpPath, this.cachePath);
      tmpPath = null;
      this._lastSavedJson = serialized;
      return true;
    } catch {
      // Persistence failures must not break status processing; remove only our temp.
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (tmpPath) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }
    return false;
  }

  processSessions(sessions = []) {
    const events = [];
    const activeIds = new Set();

    for (const session of sessions) {
      if (!session || !session.session_id) continue;
      const sid = String(session.session_id);
      activeIds.add(sid);

      const cached = this._cache.sessions[sid];

      if (this._isFirstScan) {
        if (!cached) {
          this._cache.sessions[sid] = {
            lastStatus: session.status,
            notifiedStatus: null,
          };
        }
        continue;
      }

      const prevStatus = cached ? cached.lastStatus : null;
      const decision = shouldNotify(prevStatus, session, { notifyDone: this.notifyDone });

      if (decision.notify) {
        if (!cached || cached.notifiedStatus !== session.status) {
          const payload = formatNotification(session);
          events.push({
            session,
            ...payload,
            reason: decision.reason,
          });
          this._cache.sessions[sid] = {
            lastStatus: session.status,
            notifiedStatus: session.status,
            notifiedAt: Date.now(),
          };
        }
      } else {
        const currentNotified = (session.status === STATUS.COOKING) ? null : (cached ? cached.notifiedStatus : null);
        if (!cached || cached.lastStatus !== session.status || cached.notifiedStatus !== currentNotified) {
          this._cache.sessions[sid] = {
            lastStatus: session.status,
            notifiedStatus: currentNotified,
            notifiedAt: cached ? cached.notifiedAt : null,
          };
        }
      }
    }

    if (this._isFirstScan) {
      this._isFirstScan = false;
    }

    // ponytail: remove missing sessions immediately, upgrade to ttl cache if ghost sessions need tracking
    for (const sid of Object.keys(this._cache.sessions)) {
      if (!activeIds.has(sid)) {
        delete this._cache.sessions[sid];
      }
    }

    this.save();
    return events;
  }
}
