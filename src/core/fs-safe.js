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

function ownedByCurrentUser(st) {
  return typeof process.getuid !== 'function' || st.uid === process.getuid();
}

// Throws unless `dir` can hold session state:
// - a real directory owned by the current user (tightened to 0700 if broader), or
// - a symlink owned by the current user to a directory the current user owns that is
//   already private (no group/other access). A symlink target is never chmod-ed: a broad
//   target is refused with an explanation instead.
// The extension (ensurePrivateDir in both variants) applies the same rules.
function assertTrustedStateDir(dir) {
  const link = fs.lstatSync(dir);
  if (link.isSymbolicLink()) {
    let target;
    try {
      target = fs.statSync(dir);
    } catch {
      throw new Error(`LetItCook state directory is a broken symlink: ${dir}`);
    }
    if (!ownedByCurrentUser(link) || !ownedByCurrentUser(target)) {
      throw new Error(`LetItCook state directory is not owned by the current user; refusing to use it: ${dir}`);
    }
    if (!target.isDirectory()) {
      throw new Error(`LetItCook state path is not a directory: ${dir}`);
    }
    if ((target.mode & 0o077) !== 0) {
      throw new Error(`LetItCook state directory is a symlink to a directory other users can access; run chmod 700 on its target: ${dir}`);
    }
    return;
  }
  if (!link.isDirectory()) {
    throw new Error(`LetItCook state path is not a directory: ${dir}`);
  }
  if (!ownedByCurrentUser(link)) {
    throw new Error(`LetItCook state directory is not owned by the current user; refusing to use it: ${dir}`);
  }
  hardenDir(dir);
}

// Create `dir` (and missing parents) owner-only and correct an existing LetItCook
// state directory that was created with broader permissions. Only `dir` itself and,
// for the standard `.../letitcook/sessions` layout, its `letitcook` parent are
// checked and modified; unrelated ancestors are never chmod-ed.
//
// Throws if either is not trusted (see assertTrustedStateDir), for example a misset
// XDG_STATE_HOME or a run under sudo: session state is never written into a directory
// someone else controls.
export function ensurePrivateDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch (error) {
    // A path that is a symlink (e.g. a broken one) is reported clearly below.
    let isLink = false;
    try { isLink = fs.lstatSync(dir).isSymbolicLink(); } catch {}
    if (!isLink) throw error;
  }
  const parent = path.dirname(dir);
  if (path.basename(dir) === 'sessions' && path.basename(parent) === 'letitcook') {
    assertTrustedStateDir(parent);
  }
  assertTrustedStateDir(dir);
}
