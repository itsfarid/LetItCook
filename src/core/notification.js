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

// Notification text is built from agent-provided reasons (error messages, commands, model
// output). Keep one short line: no stack traces, control characters or credentials.
// The GNOME extension evaluates this on the Shell's main thread, so no pattern ever sees
// more than the bounded first line (NOTIFY_INPUT_MAX characters), and secret redaction
// works word by word in linear time.
// The GNOME extension (both variants) carries an identical copy of these helpers.
const NOTIFY_SUBJECT_MAX = 80;
const NOTIFY_REASON_MAX = 80;
const NOTIFY_INPUT_MAX = 512;
const SECRET_KEY_RE = /api[_-]?key|token|secret|password|passwd|credential|authorization|cookie/i;

// First line of untrusted text, at most NOTIFY_INPUT_MAX + 1 characters.
function notificationFirstLine(value) {
  const head = value.slice(0, NOTIFY_INPUT_MAX + 1);
  const end = head.search(/[\r\n]/);
  return end === -1 ? head : head.slice(0, end);
}

// A line over NOTIFY_INPUT_MAX is cut at the last whitespace before the limit, so a
// partly cut word (possibly part of a secret) is dropped entirely, and the cut is marked.
function boundNotificationText(text) {
  if (text.length <= NOTIFY_INPUT_MAX) return text;
  let cut = NOTIFY_INPUT_MAX - 2;
  while (cut > 0 && !/\s/.test(text[cut])) cut--;
  return `${text.slice(0, cut).trimEnd()} …`.trimStart();
}

function openQuote(value) {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.indexOf(quote, 1) === -1 ? quote : '';
}

// Redact the value after a sensitive key: `key=value`, `prefix:key=value`, `key: value`,
// `key = value`, `--key value`, and after `Bearer`. Each word is scanned once.
function redactNotificationSecrets(text) {
  const words = text.split(/(\s+)/); // words at even indexes, whitespace in between
  let redactNext = false;
  let quote = '';
  for (let i = 0; i < words.length; i += 2) {
    const word = words[i];
    if (!word) continue;
    if (word === '…') { // truncation marker, never a value
      redactNext = false;
      continue;
    }
    if (quote) { // rest of a quoted secret value
      words[i] = '';
      if (word.includes(quote)) quote = '';
      continue;
    }
    if (redactNext) {
      if (word === '=' || word === ':') continue;
      words[i] = '[redacted]';
      redactNext = /^bearer$/i.test(word);
      quote = openQuote(word);
      continue;
    }
    let start = 0;
    let separator = -1;
    for (let j = 0; j < word.length && separator === -1; j++) {
      if (word[j] !== ':' && word[j] !== '=') continue;
      if (SECRET_KEY_RE.test(word.slice(start, j))) separator = j;
      start = j + 1;
    }
    if (separator !== -1) {
      const value = word.slice(separator + 1);
      if (value) {
        words[i] = `${word.slice(0, separator + 1)}[redacted]`;
        quote = openQuote(value);
      } else {
        redactNext = true;
      }
    } else if (/^bearer$/i.test(word) ||
               (SECRET_KEY_RE.test(word) && (word[0] === '-' || words[i + 2] === '=' || words[i + 2] === ':'))) {
      redactNext = true;
    }
  }
  return words.join('');
}

export function cleanNotificationText(value, maxLen) {
  if (typeof value !== 'string') return '';
  let text = boundNotificationText(notificationFirstLine(value)); // drops stack traces and dumps
  text = text.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, ''); // ANSI escape sequences
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  // Invisible direction overrides/isolates and zero-width spaces (ZWNJ/ZWJ kept for scripts and emoji)
  text = text.replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '');
  text = redactNotificationSecrets(text);
  text = text.replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]'); // long tokens and keys
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

// Your Turn shows only what kind of input is needed: the first two `category:detail`
// fields of the reason (e.g. `permission.asked:bash`), never the payload such as command
// arguments. Other reasons keep their message, with URLs reduced to their host and
// absolute paths to their last component.
export function notificationReason(status, reason) {
  if (typeof reason !== 'string') return '';
  let text = notificationFirstLine(reason);
  if (status === STATUS.YOUR_TURN) text = text.split(':').slice(0, 2).join(':');
  text = boundNotificationText(text);
  text = text.replace(/\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/@]*@)?([^\s/?#'"]+)[^\s'"]*/gi, '$1://$2');
  text = text.replace(/(?:~|\.{1,2})?\/(?:[^\s/'"`,;:()]+\/)+([^\s/'"`,;:()]*)/g, '…/$1');
  return cleanNotificationText(text, NOTIFY_REASON_MAX);
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
  const agent = cleanNotificationText(session?.agent || 'Agent', 32) || 'Agent';
  const title = `LetItCook: ${agent}`;
  const status = session?.status;
  const reason = notificationReason(status, session?.reason);
  const subject = cleanNotificationText(session?.title || shortCwd(session?.cwd), NOTIFY_SUBJECT_MAX);

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
