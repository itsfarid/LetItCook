import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATUS } from '../src/core/status.js';
import { isValidSessionId, ensurePrivateDir } from '../src/core/fs-safe.js';
import {
  writeSessionFile,
  deleteSessionFile,
  readAllSessionsFromDir,
  OpenCodeAdapter,
} from '../src/adapters/opencode/adapter.js';
import { CopilotAdapter, readSessionFromDir } from '../src/adapters/copilot/adapter.js';

const BAD_IDS = [
  '../../evil', '..', '.', '../x', 'a/b', 'a\\b', '/etc/passwd', '.hidden', '',
  'a\0b', 'a b', 'x'.repeat(200), null, undefined, 42, {}, ['a'],
];
const GOOD_IDS = ['global', 'ses_abc123', 'ses_01HXYZ-abc.def', '3f2b8c1e-9d4a-4e7b-8a21-5c6d7e8f9a0b', 'test_ses_1'];

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `letitcook-${prefix}-`));
}

function mode(p) {
  return fs.lstatSync(p).mode & 0o777;
}

function listTree(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      out.push(path.relative(root, full));
      if (e.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}

function testSessionIdValidator() {
  for (const id of GOOD_IDS) assert.strictEqual(isValidSessionId(id), true, `valid: ${id}`);
  for (const id of BAD_IDS) assert.strictEqual(isValidSessionId(id), false, `invalid: ${JSON.stringify(id)}`);
}

function testOpenCodeRejectsTraversal() {
  const root = mkTmp('fs-oc');
  const stateDir = path.join(root, 'a', 'b', 'sessions');
  fs.mkdirSync(stateDir, { recursive: true });
  const victim = path.join(root, 'victim.json');
  const victim2 = path.join(root, 'a', 'victim.json');
  fs.writeFileSync(victim, '{"keep":true}');
  fs.writeFileSync(victim2, '{"keep":true}');
  try {
    const before = listTree(root);

    // writes: refused, nothing created anywhere in the tree
    for (const id of ['../../evil', '../evil', 'a/b', '/abs']) {
      assert.throws(() => writeSessionFile({ session_id: id, agent: 'opencode', status: STATUS.COOKING }, stateDir), /Invalid session id/);
    }
    assert.throws(() => writeSessionFile({ agent: 'opencode', status: STATUS.COOKING }, stateDir));
    assert.deepStrictEqual(listTree(root), before, 'rejected writes must not touch the filesystem');

    // deletes: refused, files outside the state dir survive
    deleteSessionFile('../../victim', stateDir);
    deleteSessionFile('../victim', stateDir);
    assert.ok(fs.existsSync(victim) && fs.existsSync(victim2), 'traversal delete must not remove outside files');

    // reads
    const adapter = new OpenCodeAdapter();
    assert.strictEqual(adapter.getSessionState('../../victim', { baseDir: stateDir }), null);

    // a state file that CLAIMS a traversal id (even terminated) must not delete anything
    fs.writeFileSync(path.join(stateDir, 'legit.json'), JSON.stringify({
      session_id: '../../victim', agent: 'opencode', status: STATUS.DONE, terminated: true,
    }));
    const sessions = readAllSessionsFromDir(stateDir);
    assert.ok(fs.existsSync(victim) && fs.existsSync(victim2), 'terminated state with traversal id must not delete outside files');
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].session_id, 'legit', 'untrusted id replaced by the file-name id');
    assert.strictEqual(sessions[0].status, STATUS.UNKNOWN, 'invalid state is Unknown, never Done');

    // file names that are not valid ids are skipped, not trusted
    fs.writeFileSync(path.join(stateDir, 'bad name.json'), '{ nope');
    assert.deepStrictEqual(readAllSessionsFromDir(stateDir).map(s => s.session_id), ['legit']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testOpenCodeValidIdsPreserved() {
  const dir = mkTmp('fs-oc-valid');
  try {
    for (const id of GOOD_IDS) {
      writeSessionFile({ session_id: id, agent: 'opencode', status: STATUS.COOKING, updated_at: Date.now() }, dir);
    }
    assert.deepStrictEqual(
      readAllSessionsFromDir(dir).map(s => s.session_id).sort(),
      [...GOOD_IDS].sort(),
    );
    const adapter = new OpenCodeAdapter();
    for (const id of GOOD_IDS) {
      assert.strictEqual(adapter.getSessionState(id, { baseDir: dir }).session_id, id);
    }
    deleteSessionFile('ses_abc123', dir);
    assert.ok(!fs.existsSync(path.join(dir, 'ses_abc123.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeCopilotSession(copilotDir, dirName, wsId) {
  const d = path.join(copilotDir, 'session-state', dirName);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'workspace.yaml'), `id: ${wsId}\ncwd: /tmp/app\nname: T\ncreated_at: 2026-10-06T10:00:00.000Z\nupdated_at: 2026-10-06T10:05:00.000Z\n`);
  fs.writeFileSync(path.join(d, 'events.jsonl'), [
    JSON.stringify({ type: 'session.start', data: { sessionId: wsId }, timestamp: '2026-10-06T10:00:00.000Z' }),
    JSON.stringify({ type: 'assistant.turn_start', data: {}, timestamp: '2026-10-06T10:01:00.000Z' }),
  ].join('\n'));
  return d;
}

function testCopilotRejectsTraversal() {
  const root = mkTmp('fs-cp');
  const copilotDir = path.join(root, 'copilot');
  const target = path.join(root, 'out', 'letitcook', 'sessions');
  const now = new Date('2026-10-06T10:06:00.000Z').getTime();
  try {
    writeCopilotSession(copilotDir, 'ses_ok_1', 'ses_ok_1');
    // workspace.yaml claims a traversal id: fall back to the (valid) directory name
    const evilDir = writeCopilotSession(copilotDir, 'fallback-dir', '../../evil');
    // neither id nor directory name is usable: session ignored
    assert.strictEqual(readSessionFromDir(path.join(root, 'weird dir'), {}), null);
    fs.mkdirSync(path.join(copilotDir, 'session-state', 'bad dir'), { recursive: true });
    fs.writeFileSync(path.join(copilotDir, 'session-state', 'bad dir', 'workspace.yaml'), 'id: "x y"\n');

    const adapter = new CopilotAdapter();
    const detected = adapter.detectSessions({ copilotDir, now });
    assert.deepStrictEqual(detected.map(s => s.session_id).sort(), ['fallback-dir', 'ses_ok_1']);
    assert.ok(readSessionFromDir(evilDir, { now }).session_id === 'fallback-dir');

    assert.strictEqual(adapter.getSessionState('../../evil', { copilotDir, now }), null);
    assert.strictEqual(adapter.getSessionState('../session-state/ses_ok_1', { copilotDir, now }), null);
    assert.ok(adapter.getSessionState('ses_ok_1', { copilotDir, now }), 'valid id still resolves');

    // an event carrying an invalid sessionId must not leak into the session id
    const evDir = writeCopilotSession(copilotDir, 'ev-dir', 'ses_ev_1');
    fs.writeFileSync(path.join(evDir, 'events.jsonl'),
      JSON.stringify({ type: 'session.start', data: { sessionId: '../../x' }, timestamp: '2026-10-06T10:00:00.000Z' }));
    assert.strictEqual(readSessionFromDir(evDir, { now }).session_id, 'ses_ev_1');

    const live = adapter.syncToStateDir(target, { copilotDir, now });
    assert.ok(live.length >= 2);
    const written = listTree(path.join(root, 'out'));
    for (const rel of written) {
      assert.ok(!rel.includes('..'), `no traversal artifacts: ${rel}`);
    }
    assert.deepStrictEqual(
      fs.readdirSync(target).sort(),
      live.map(s => `copilot_${s.session_id}.json`).sort(),
    );
    assert.ok(!fs.existsSync(path.join(root, 'evil.json')));
    assert.ok(!fs.existsSync(path.join(root, 'out', 'evil.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testPrivateDirectoryPermissions() {
  const root = mkTmp('fs-perm');
  try {
    fs.chmodSync(root, 0o755);

    // new nested directory is owner-only
    const fresh = path.join(root, 'fresh', 'letitcook', 'sessions');
    ensurePrivateDir(fresh);
    assert.strictEqual(mode(fresh), 0o700);
    assert.strictEqual(mode(path.join(root, 'fresh', 'letitcook')), 0o700);

    // existing broad directories are corrected, unrelated parents are not touched
    const parent = path.join(root, 'state');
    const app = path.join(parent, 'letitcook');
    const sessions = path.join(app, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    for (const d of [parent, app, sessions]) fs.chmodSync(d, 0o755);
    ensurePrivateDir(sessions);
    assert.strictEqual(mode(sessions), 0o700);
    assert.strictEqual(mode(app), 0o700);
    assert.strictEqual(mode(parent), 0o755, 'unrelated parent must be unchanged');
    assert.strictEqual(mode(root), 0o755, 'unrelated ancestor must be unchanged');

    // a custom directory only has itself tightened, not its parent
    const custom = path.join(root, 'custom', 'data');
    fs.mkdirSync(custom, { recursive: true });
    fs.chmodSync(path.join(root, 'custom'), 0o755);
    fs.chmodSync(custom, 0o755);
    ensurePrivateDir(custom);
    assert.strictEqual(mode(custom), 0o700);
    assert.strictEqual(mode(path.join(root, 'custom')), 0o755);

    // symlinks are never followed for chmod
    const realTarget = path.join(root, 'real');
    fs.mkdirSync(realTarget);
    fs.chmodSync(realTarget, 0o755);
    const link = path.join(root, 'link');
    fs.symlinkSync(realTarget, link);
    ensurePrivateDir(link);
    assert.strictEqual(mode(realTarget), 0o755, 'symlink target must not be chmod-ed');

    // writing a session into a pre-existing 0755 directory tightens it
    const wide = path.join(root, 'wide');
    fs.mkdirSync(wide);
    fs.chmodSync(wide, 0o755);
    writeSessionFile({ session_id: 'ses_perm', agent: 'opencode', status: STATUS.COOKING }, wide);
    assert.strictEqual(mode(wide), 0o700);

    // existing file permissions are left alone (idempotent, no surprise side effects)
    ensurePrivateDir(wide);
    assert.strictEqual(mode(wide), 0o700);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCopilotSyncCreatesPrivateDir() {
  const root = mkTmp('fs-perm-sync');
  try {
    const target = path.join(root, 'letitcook', 'sessions');
    new CopilotAdapter().syncToStateDir(target, { copilotDir: path.join(root, 'none') });
    assert.strictEqual(mode(target), 0o700);
    assert.strictEqual(mode(path.join(root, 'letitcook')), 0o700);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- GNOME extension behaviour -------------------------------------------------
// The extensions import gi:// modules, so they cannot be loaded under Node. Instead
// the real `_readSessions` method source is extracted and executed against fake
// Gio/GLib objects, exercising the actual enumerator cleanup code of each target.
function loadReadSessions(target) {
  const code = fs.readFileSync(path.resolve(`${target}/extension.js`), 'utf8');
  const match = code.match(/\n    _readSessions\(\) \{\n([\s\S]*?)\n    \}\n/);
  assert.ok(match, `${target}: _readSessions not found`);
  const logs = [];
  const fakeConsole = { error: m => logs.push(String(m)) };
  const meta = {};
  for (const s of Object.values(STATUS)) meta[s] = { priority: 0 };
  const factory = new Function(
    'Gio', 'GLib', 'STATUS', 'STATUS_META', 'STALE_TIMEOUT_MS', 'DEAD_SESSION_RETENTION_MS', 'console', 'log',
    `return function _readSessions() {\n${match[1]}\n};`,
  );
  return (Gio, GLib) => ({
    fn: factory(Gio, GLib, STATUS, meta, 5 * 60 * 1000, 60 * 60 * 1000, fakeConsole, fakeConsole.error),
    logs,
  });
}

function makeFakeGio({ files = [], enumerateThrows = false, nextFileThrowsAt = -1, loadThrows = false, closeThrows = false }) {
  const state = { opened: 0, closed: 0 };
  const Gio = {
    FileQueryInfoFlags: { NONE: 0 },
    File: {
      new_for_path(p) {
        return {
          enumerate_children() {
            if (enumerateThrows) throw new Error('enumerate failed');
            state.opened++;
            let i = 0;
            return {
              next_file() {
                if (i === nextFileThrowsAt) throw new Error('next_file failed');
                if (i >= files.length) return null;
                return { get_name: () => files[i++] };
              },
              close() {
                state.closed++;
                if (closeThrows) throw new Error('close failed');
              },
            };
          },
          load_contents() {
            if (loadThrows) throw new Error('read failed');
            return [true, new TextEncoder().encode(JSON.stringify({ session_id: 'a', status: STATUS.COOKING, updated_at: Date.now() }))];
          },
          delete() {},
        };
      },
    },
  };
  const GLib = {
    build_filenamev: parts => parts.join('/'),
    file_test: () => true,
    FileTest: { EXISTS: 1 },
  };
  return { Gio, GLib, state };
}

function testExtensionEnumeratorCleanup() {
  for (const target of ['extension', 'extension-legacy']) {
    const load = loadReadSessions(target);
    const run = (opts) => {
      const { Gio, GLib, state } = makeFakeGio(opts);
      const { fn, logs } = load(Gio, GLib);
      const result = fn.call({ _stateDir: '/fake/state' });
      return { result, state, logs };
    };

    let r = run({ files: ['a.json', 'b.json'] });
    assert.strictEqual(r.result.length, 2, `${target}: sessions read`);
    assert.deepStrictEqual(r.state, { opened: 1, closed: 1 }, `${target}: closed on success`);

    r = run({ files: [] });
    assert.deepStrictEqual(r.state, { opened: 1, closed: 1 }, `${target}: closed when empty`);

    r = run({ files: ['a.json', 'b.json'], nextFileThrowsAt: 1 });
    assert.deepStrictEqual(r.state, { opened: 1, closed: 1 }, `${target}: closed when next_file throws`);
    assert.ok(r.logs.some(l => l.includes('Error reading sessions')), `${target}: read error still reported`);

    r = run({ files: ['a.json'], loadThrows: true });
    assert.deepStrictEqual(r.state, { opened: 1, closed: 1 }, `${target}: closed when a file read fails`);
    assert.strictEqual(r.result[0].status, STATUS.UNKNOWN, `${target}: unreadable state is Unknown`);

    r = run({ enumerateThrows: true });
    assert.deepStrictEqual(r.state, { opened: 0, closed: 0 }, `${target}: nothing to close when open fails`);
    assert.deepStrictEqual(r.result, []);

    r = run({ files: ['a.json'], closeThrows: true });
    assert.strictEqual(r.result.length, 1, `${target}: close failure does not lose sessions`);
    assert.strictEqual(r.state.closed, 1);
    assert.ok(r.logs.some(l => l.includes('Error closing enumerator')), `${target}: close failure is logged`);
  }
}

function testExtensionStateDirPermissionsSource() {
  // Source-level guard (GJS cannot run under Node): directory creation must be 0700,
  // and both LetItCook-owned directories must be corrected after creation.
  for (const target of ['extension', 'extension-legacy']) {
    const code = fs.readFileSync(path.resolve(`${target}/extension.js`), 'utf8');
    assert.ok(code.includes('GLib.mkdir_with_parents(this._stateDir, 0o700)'), `${target}: mkdir 0700`);
    assert.ok(!/mkdir_with_parents\([^)]*0o7[1-7][0-7]\)/.test(code), `${target}: no broad mkdir mode`);
    assert.ok(code.includes('ensurePrivateDir(GLib.path_get_dirname(this._stateDir))'), `${target}: parent letitcook dir hardened`);
    assert.ok(code.includes('ensurePrivateDir(this._stateDir)'), `${target}: sessions dir hardened`);
    assert.ok(code.includes("dirFile.set_attribute_uint32('unix::mode', 0o700, flags, null)"), `${target}: safely set mode 0700`);
    assert.ok(code.includes('Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS'), `${target}: directory metadata does not follow symlinks`);
    assert.ok(code.includes('GLib.FileTest.IS_SYMLINK'), `${target}: cache symlinks skipped`);
    const cacheHelper = code.match(/function ensurePrivateNotifyCacheFile\(path\) \{[\s\S]*?\n\}/);
    assert.ok(cacheHelper, `${target}: cache file permission helper`);
    assert.ok(cacheHelper[0].includes('Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS'), `${target}: metadata query does not follow symlinks`);
    assert.ok(cacheHelper[0].includes("'unix::nlink'"), `${target}: hard links are rejected`);
    assert.ok(cacheHelper[0].includes("'owner::user'"), `${target}: cache owner is verified`);
    assert.ok(cacheHelper[0].includes('& 0o777) === 0o600'), `${target}: existing cache must be exactly 0600`);
    assert.ok(!cacheHelper[0].includes('GLib.chmod'), `${target}: cache hard-link permissions are not changed via path chmod`);
    assert.ok(cacheHelper[0].includes('Gio.FileCreateFlags.PRIVATE'), `${target}: broad existing file is privately replaced`);
    assert.ok(code.includes('ensurePrivateNotifyCacheFile(this._notifyCacheFile)'), `${target}: cache read/write validates file path`);
  }
}

// Session files are documented as owner-only (0600); previously they inherited the
// umask (0644 observed on a real install), relying solely on the 0700 directory.
function testSessionFilesArePrivate() {
  const root = mkTmp('fs-file-mode');
  const oldUmask = process.umask(0o022);
  try {
    const target = path.join(root, 'letitcook', 'sessions');
    writeSessionFile({ session_id: 'ses_mode', agent: 'opencode', status: STATUS.COOKING }, target);
    assert.strictEqual(mode(path.join(target, 'ses_mode.json')), 0o600, 'OpenCode session file is 0600');
    // Rewriting keeps it private.
    writeSessionFile({ session_id: 'ses_mode', agent: 'opencode', status: STATUS.DONE }, target);
    assert.strictEqual(mode(path.join(target, 'ses_mode.json')), 0o600, 'rewritten session file stays 0600');

    const copilotDir = path.join(root, 'copilot');
    const sdir = path.join(copilotDir, 'session-state', 'cp-mode');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'workspace.yaml'), 'id: cp-mode\n');
    fs.writeFileSync(path.join(sdir, 'events.jsonl'), JSON.stringify({ type: 'session.start', data: { sessionId: 'cp-mode' }, timestamp: new Date().toISOString() }) + '\n');
    new CopilotAdapter().syncToStateDir(target, { copilotDir });
    assert.strictEqual(mode(path.join(target, 'copilot_cp-mode.json')), 0o600, 'Copilot synced file is 0600');
  } finally {
    process.umask(oldUmask);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run() {
  testSessionIdValidator();
  testOpenCodeRejectsTraversal();
  testOpenCodeValidIdsPreserved();
  testCopilotRejectsTraversal();
  testPrivateDirectoryPermissions();
  testCopilotSyncCreatesPrivateDir();
  testSessionFilesArePrivate();
  testExtensionEnumeratorCleanup();
  testExtensionStateDirPermissionsSource();
  console.log('All LetItCook filesystem hardening tests passed.');
}

run();
