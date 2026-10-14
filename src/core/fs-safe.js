import fs from 'node:fs';
import path from 'node:path';

// Session IDs become file names (`<id>.json`, `copilot_<id>.json`) so they must be
// plain, non-hidden file-name tokens. This accepts OpenCode (`ses_...`), Copilot
// (UUID) and the literal `global`, and rejects separators, traversal and NUL.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

export function assertValidSessionId(id) {
  if (!isValidSessionId(id)) {
    throw new Error('Invalid session id');
  }
  return id;
}

const PRIVATE_DIR_MODE = 0o700;

// Tighten a single directory to owner-only. Symlinks, non-directories and
// directories owned by someone else are left alone.
function hardenDir(dir) {
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return;
    if ((st.mode & 0o777) !== PRIVATE_DIR_MODE) {
      fs.chmodSync(dir, PRIVATE_DIR_MODE);
    }
  } catch {}
}

// Create `dir` (and missing parents) owner-only and correct an existing LetItCook
// state directory that was created with broader permissions. Only `dir` itself and,
// for the standard `.../letitcook/sessions` layout, its `letitcook` parent are
// modified; unrelated ancestors are never chmod-ed.
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  hardenDir(dir);
  const parent = path.dirname(dir);
  if (path.basename(dir) === 'sessions' && path.basename(parent) === 'letitcook') {
    hardenDir(parent);
  }
}
