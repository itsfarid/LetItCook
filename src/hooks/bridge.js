// Shared runtime for hook-based adapters. An agent runs `node src/hooks/hook.js <agent>`
// for each hook event with the event JSON on stdin; this module turns it into session
// state:
//
//   stdin (bounded) -> JSON -> adapter.toSignals(input) -> reduceSession -> state file
//
// The hook is a pure observer: it prints nothing, always exits 0 and never blocks the
// agent for long. Any failure (bad input, unusable state directory) leaves the state
// unchanged; it is never turned into a status.

import fs from 'node:fs';
import path from 'node:path';
import { reduceSession, shouldPersist } from '../core/lifecycle.js';
import { ensurePrivateDir, isValidSessionId } from '../core/fs-safe.js';
import { getSessionDir } from '../adapters/opencode/adapter.js';

// Hook payloads can carry whole tool outputs; anything larger is ignored (and drained).
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;
// A holder keeps the lock for a few milliseconds. A lock older than LOCK_STALE_MS was left
// by a hook that crashed or was killed and is broken; the wait stays well inside the
// shortest agent hook timeout (3 s for Codex).
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 1000;
const MAX_STATE_FILE_BYTES = 256 * 1024;

export async function readBoundedStdin(stream = process.stdin, maxBytes = MAX_INPUT_BYTES) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of stream) {
    if (overflow) continue;
    size += chunk.length;
    if (size > maxBytes) {
      overflow = true;
      chunks.length = 0;
    } else {
      chunks.push(chunk);
    }
  }
  return overflow ? null : Buffer.concat(chunks).toString('utf8');
}

export function parseHookInput(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Shells and wrappers that may sit between the agent and this hook process.
const WRAPPERS = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'env', 'timeout', 'nice', 'nohup', 'npx', 'npm']);

function readProcStat(procRoot, pid) {
  const text = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
  // Format: "pid (comm) state ppid ..."; comm may contain spaces and parentheses.
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).split(' ');
  const ppid = Number.parseInt(rest[1], 10);
  return { comm: text.slice(open + 1, close), ppid: Number.isInteger(ppid) ? ppid : 0 };
}

// The agent process that ran this hook: the nearest ancestor that is not a shell or
// wrapper. The panel uses it to notice the agent exiting. Returns null when it cannot be
// determined (no /proc, unexpected layout); the session then has no process to watch.
export function findAgentPid({ procRoot = '/proc', startPid = process.ppid, maxDepth = 4 } = {}) {
  let pid = startPid;
  for (let depth = 0; depth < maxDepth && Number.isInteger(pid) && pid > 1; depth++) {
    let stat;
    try {
      stat = readProcStat(procRoot, pid);
    } catch {
      return null;
    }
    if (!stat) return null;
    if (!WRAPPERS.has(stat.comm)) return pid;
    pid = stat.ppid;
  }
  return null;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Serializes the read-modify-write of one session file between concurrent hook
// processes (agents may run hooks for parallel tool calls at the same time). Returns a
// release function, or null when the lock could not be taken in time: the update is then
// skipped, because writing unlocked could replace another hook's waiting request.
export function acquireLock(lockPath, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx', 0o600));
      return () => { try { fs.unlinkSync(lockPath); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') return null;
    }
    try {
      if (Date.now() - fs.lstatSync(lockPath).mtimeMs > staleMs) {
        fs.unlinkSync(lockPath);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() >= deadline) return null;
    sleepMs(5);
  }
}

// Reads this adapter's previous record without following symlinks. It must be what the
// bridge writes: a private (0600-style), single-link regular file owned by the current
// user. Anything else, an oversized file, or one that does not parse is ignored (the next
// write replaces it with a fresh record).
export function readStateFile(filePath, expected) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_STATE_FILE_BYTES) return null;
    if (st.nlink !== 1 || (st.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!value || value.session_id !== expected.sessionId || value.agent !== expected.agent) return null;
    return value;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Atomic replace. A failed write or rename removes its temporary file, so failures (a full
// disk) cannot accumulate hidden files; the previous state file stays as it was.
export function writeStateFile(dir, filePath, record, fsImpl = fs) {
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let created = false;
  try {
    const fd = fsImpl.openSync(tmpPath, 'wx', 0o600);
    created = true;
    try {
      fsImpl.writeFileSync(fd, JSON.stringify(record, null, 2), 'utf8');
    } finally {
      fsImpl.closeSync(fd);
    }
    fsImpl.renameSync(tmpPath, filePath);
  } catch (error) {
    if (created) {
      try { fsImpl.unlinkSync(tmpPath); } catch {}
    }
    throw error;
  }
}

export function stateFileName(agent, sessionId) {
  return `${agent}_${sessionId}.json`;
}

// Applies an adapter's signals to the state directory. Returns the records written or
// removed (for tests and diagnostics).
export function applySignals(agent, signals, { stateDir = getSessionDir(), now = Date.now(), pid = null, lockTimeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const results = [];
  if (!Array.isArray(signals) || signals.length === 0) return results;
  ensurePrivateDir(stateDir);
  for (const signal of signals) {
    if (!signal || !isValidSessionId(signal.sessionId)) continue;
    const filePath = path.join(stateDir, stateFileName(agent, signal.sessionId));
    const release = acquireLock(path.join(stateDir, `.${stateFileName(agent, signal.sessionId)}.lock`), { timeoutMs: lockTimeoutMs });
    if (!release) continue;
    try {
      const prev = readStateFile(filePath, { sessionId: signal.sessionId, agent });
      const next = reduceSession(prev, signal, { agent, now, pid });
      if (!next || !shouldPersist(prev, next)) continue;
      if (next.deleted) {
        try {
          if (fs.lstatSync(filePath).isFile()) fs.unlinkSync(filePath);
        } catch {}
      } else {
        writeStateFile(stateDir, filePath, next);
      }
      results.push(next);
    } finally {
      release();
    }
  }
  return results;
}

// Entry point for one hook invocation. Never throws.
export async function runHook(adapter, { stdin = process.stdin, stateDir, now, pid } = {}) {
  try {
    const input = parseHookInput(await readBoundedStdin(stdin));
    if (!input) return [];
    const signals = adapter.toSignals(input);
    if (!Array.isArray(signals) || signals.length === 0) return [];
    return applySignals(adapter.id, signals, {
      stateDir: stateDir || getSessionDir(),
      now: now || Date.now(),
      pid: pid === undefined ? findAgentPid() : pid,
    });
  } catch {
    return [];
  }
}

export default {
  MAX_INPUT_BYTES,
  readBoundedStdin,
  parseHookInput,
  findAgentPid,
  acquireLock,
  readStateFile,
  stateFileName,
  applySignals,
  runHook,
};
