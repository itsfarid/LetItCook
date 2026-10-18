import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { STATUS, STATUS_META, normalizeSession } from '../src/core/status.js';
import { NotificationTracker, formatNotification, cleanNotificationText } from '../src/core/notification.js';

function testModernMetadataCompatibility() {
  const metadataPath = path.resolve('extension/metadata.json');
  assert.ok(fs.existsSync(metadataPath), 'extension/metadata.json must exist');

  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.strictEqual(metadata.uuid, 'letitcook@letitcook.local');
  assert.strictEqual(metadata.name, 'LetItCook');
  assert.ok(Array.isArray(metadata['shell-version']));

  const versions = metadata['shell-version'];
  assert.ok(versions.includes('45'), 'Must support GNOME 45');
  assert.ok(versions.includes('46'), 'Must support GNOME 46');
  assert.ok(versions.includes('47'), 'Must support GNOME 47');

  for (const v of ['42', '43', '44']) {
    assert.strictEqual(versions.includes(v), false, `Modern metadata must not include pre-45 version ${v}`);
  }
}

function testLegacyMetadataCompatibility() {
  const metadataPath = path.resolve('extension-legacy/metadata.json');
  assert.ok(fs.existsSync(metadataPath), 'extension-legacy/metadata.json must exist');

  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.strictEqual(metadata.uuid, 'letitcook@letitcook.local');
  assert.strictEqual(metadata.name, 'LetItCook');
  assert.ok(Array.isArray(metadata['shell-version']));

  const versions = metadata['shell-version'];
  assert.ok(versions.includes('42'), 'Must support GNOME 42');
  assert.ok(versions.includes('43'), 'Must support GNOME 43');
  assert.ok(versions.includes('44'), 'Must support GNOME 44');

  for (const v of ['45', '46', '47']) {
    assert.strictEqual(versions.includes(v), false, `Legacy metadata must not include GNOME 45+ version ${v}`);
  }
}

function testModernExtensionESMSyntax() {
  const extensionPath = path.resolve('extension/extension.js');
  assert.ok(fs.existsSync(extensionPath), 'extension/extension.js must exist');

  const result = execFileSync('node', ['--check', extensionPath], { encoding: 'utf8' });
  assert.strictEqual(result, '', 'extension.js must parse cleanly as valid JS syntax');

  const code = fs.readFileSync(extensionPath, 'utf8');

  // Must not use legacy GJS globals
  assert.strictEqual(/imports\.gi/.test(code), false, 'Must not use imports.gi in modern extension');
  assert.strictEqual(/imports\.ui/.test(code), false, 'Must not use imports.ui in modern extension');
  assert.strictEqual(/imports\.misc/.test(code), false, 'Must not use imports.misc in modern extension');
  assert.strictEqual(/ExtensionUtils/.test(code), false, 'Must not use ExtensionUtils in modern extension');
  assert.strictEqual(/\blog\(/.test(code), false, 'Must not use legacy log() in modern extension');

  // Must use GNOME 45+ ESM imports
  assert.ok(/import\s+Clutter\s+from\s+'gi:\/\/Clutter'/.test(code));
  assert.ok(/import\s+Gio\s+from\s+'gi:\/\/Gio'/.test(code));
  assert.ok(/import\s+GLib\s+from\s+'gi:\/\/GLib'/.test(code));
  assert.ok(/import\s+GObject\s+from\s+'gi:\/\/GObject'/.test(code));
  assert.ok(/import\s+St\s+from\s+'gi:\/\/St'/.test(code));
  assert.ok(/import\s+\*\s+as\s+Main\s+from\s+'resource:\/\/\/org\/gnome\/shell\/ui\/main\.js'/.test(code));
  assert.ok(/import\s+\*\s+as\s+PanelMenu\s+from\s+'resource:\/\/\/org\/gnome\/shell\/ui\/panelMenu\.js'/.test(code));
  assert.ok(/import\s+\*\s+as\s+PopupMenu\s+from\s+'resource:\/\/\/org\/gnome\/shell\/ui\/popupMenu\.js'/.test(code));
  assert.ok(/import\s+\{\s*Extension\s*\}\s+from\s+'resource:\/\/\/org\/gnome\/shell\/extensions\/extension\.js'/.test(code));

  assert.ok(/export\s+default\s+class\s+LetItCookExtension\s+extends\s+Extension/.test(code));
  assert.ok(/enable\s*\(\s*\)/.test(code));
  assert.ok(/disable\s*\(\s*\)/.test(code));
}

function testLegacyExtensionSyntax() {
  const extensionPath = path.resolve('extension-legacy/extension.js');
  assert.ok(fs.existsSync(extensionPath), 'extension-legacy/extension.js must exist');

  const result = execFileSync('node', ['--check', extensionPath], { encoding: 'utf8' });
  assert.strictEqual(result, '', 'extension-legacy/extension.js must parse cleanly as valid JS syntax');

  const code = fs.readFileSync(extensionPath, 'utf8');

  // Must not use ESM export/import statements which crash GNOME 42-44 evaluator
  assert.strictEqual(/export\s+default/.test(code), false, 'Legacy extension must not contain export default');
  assert.strictEqual(/^import\s+/m.test(code), false, 'Legacy extension must not contain static import statements');

  // Must use legacy imports
  assert.ok(code.includes('const { Clutter, Gio, GLib, GObject, St } = imports.gi;'));
  assert.ok(code.includes('const Main = imports.ui.main;'));
  assert.ok(code.includes('const PanelMenu = imports.ui.panelMenu;'));
  assert.ok(code.includes('const PopupMenu = imports.ui.popupMenu;'));

  // Must export init, enable, disable functions
  assert.ok(/function\s+init\s*\(/.test(code));
  assert.ok(/function\s+enable\s*\(/.test(code));
  assert.ok(/function\s+disable\s*\(/.test(code));
}

function testExtensionStatusModelParity() {
  const targets = ['extension/extension.js', 'extension-legacy/extension.js'];

  for (const target of targets) {
    const code = fs.readFileSync(path.resolve(target), 'utf8');

    for (const [key, val] of Object.entries(STATUS)) {
      assert.ok(code.includes(`${key}: '${val}'`), `${target} must define STATUS.${key} = '${val}'`);
    }

    for (const [statusKey, meta] of Object.entries(STATUS_META)) {
      assert.ok(code.includes(`label: '${meta.label}'`), `${target} must have label '${meta.label}' for status ${statusKey}`);
      assert.ok(code.includes(`emoji: '${meta.emoji}'`), `${target} must have emoji '${meta.emoji}' for status ${statusKey}`);
      assert.ok(code.includes(`priority: ${meta.priority}`), `${target} must have priority ${meta.priority} for status ${statusKey}`);
    }

    assert.ok(code.includes('STALE_TIMEOUT_MS = 5 * 60 * 1000'), `${target} must use 5 min stale timeout`);
    assert.ok(code.includes('DEBOUNCE_DELAY_MS = 150'), `${target} must use 150ms debounce`);
    assert.ok(code.includes("GLib.build_filenamev([GLib.get_user_state_dir(), 'letitcook', 'sessions'])"), `${target} must use standard state dir`);
  }
}

function testStylesheetParity() {
  const modernCss = fs.readFileSync(path.resolve('extension/stylesheet.css'), 'utf8');
  const legacyCss = fs.readFileSync(path.resolve('extension-legacy/stylesheet.css'), 'utf8');
  assert.strictEqual(modernCss, legacyCss, 'Modern and legacy stylesheets must be identical');
}

function testSingleDotPanelFormatting() {
  const targets = ['extension/extension.js', 'extension-legacy/extension.js'];

  for (const target of targets) {
    const code = fs.readFileSync(path.resolve(target), 'utf8');

    // Panel label in _update() must be plain meta.label, never with emoji
    assert.ok(
      code.includes('this._label.text = meta.label;'),
      `${target} must assign plain meta.label to this._label.text in _update()`
    );

    // Must not contain emoji in panel label assignment
    assert.strictEqual(
      /this\._label\.text\s*=\s*`\$\{meta\.emoji\}/.test(code),
      false,
      `${target} must NOT include meta.emoji in this._label.text`
    );

    // When 0 sessions, label must be LetItCook
    assert.ok(
      code.includes("this._label.text = 'LetItCook';"),
      `${target} must assign 'LetItCook' when session count is 0`
    );
  }
}

function testDropdownMenuRetainsEmojis() {
  const targets = ['extension/extension.js', 'extension-legacy/extension.js'];

  for (const target of targets) {
    const code = fs.readFileSync(path.resolve(target), 'utf8');

    // Menu header must retain emoji
    assert.ok(
      code.includes('${meta.emoji} ${meta.label}'),
      `${target} menu header must include status emoji`
    );

    // Session items in dropdown must retain emoji
    assert.ok(
      code.includes('${meta.emoji} [${agent}]') && code.includes('formatSessionRow(s, sMeta,'),
      `${target} session items must include status emoji`
    );
  }
}

function testPanelActorHierarchyAndLifecycle() {
  // Mock St/Clutter environment for behavioral verification
  class MockActor {
    constructor(props = {}) {
      this.children = [];
      this.style_classes = new Set();
      if (props.style_class) {
        props.style_class.split(/\s+/).filter(Boolean).forEach(c => this.style_classes.add(c));
      }
      this.text = props.text || '';
    }

    add_child(child) {
      this.children.push(child);
    }

    get_children() {
      return [...this.children];
    }

    get_n_children() {
      return this.children.length;
    }

    add_style_class_name(name) {
      this.style_classes.add(name);
    }

    remove_style_class_name(name) {
      this.style_classes.delete(name);
    }

    has_style_class_name(name) {
      return this.style_classes.has(name);
    }
  }

  // Simulate panel initialization
  const button = new MockActor();
  const container = new MockActor({ style_class: 'letitcook-panel-box' });
  const dot = new MockActor({ style_class: 'letitcook-dot letitcook-dot-unknown' });
  const label = new MockActor({ text: 'LetItCook', style_class: 'letitcook-label' });

  container.add_child(dot);
  container.add_child(label);
  button.add_child(container);

  // 1. Initial hierarchy
  assert.strictEqual(button.get_n_children(), 1, 'Button has exactly 1 child (container)');
  assert.strictEqual(container.get_n_children(), 2, 'Container has exactly 2 children (dot + label)');
  assert.strictEqual(container.children[0], dot, 'First child is dot widget');
  assert.strictEqual(container.children[1], label, 'Second child is label widget');
  assert.strictEqual(label.text, 'LetItCook', 'Initial label is LetItCook');

  // 2. Simulate repeated status updates across all statuses
  const testStates = [
    { dominant: STATUS.COOKING, expectedLabel: 'Cooking', expectedClass: 'letitcook-dot-cooking' },
    { dominant: STATUS.YOUR_TURN, expectedLabel: 'Your Turn', expectedClass: 'letitcook-dot-your_turn' },
    { dominant: STATUS.DONE, expectedLabel: 'Done', expectedClass: 'letitcook-dot-done' },
    { dominant: STATUS.BURN, expectedLabel: 'Burn', expectedClass: 'letitcook-dot-burn' },
    { dominant: STATUS.UNKNOWN, expectedLabel: 'Unknown', expectedClass: 'letitcook-dot-unknown' },
  ];

  for (let round = 0; round < 20; round++) {
    for (const { dominant, expectedLabel, expectedClass } of testStates) {
      // Simulate _update logic
      for (const st of Object.values(STATUS)) {
        dot.remove_style_class_name(`letitcook-dot-${st}`);
      }
      dot.add_style_class_name(`letitcook-dot-${dominant}`);
      label.text = STATUS_META[dominant].label;

      // Assertions
      assert.strictEqual(button.get_n_children(), 1, 'Button child count must remain 1');
      assert.strictEqual(container.get_n_children(), 2, 'Container child count must remain 2');
      assert.strictEqual(dot.has_style_class_name(expectedClass), true, `Dot must have ${expectedClass}`);
      assert.strictEqual(label.text, expectedLabel, `Label text must be plain '${expectedLabel}' without emoji`);
      assert.strictEqual(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(label.text), false, 'Label must not contain emoji');
    }
  }

  // 3. Return to 0 sessions
  for (const st of Object.values(STATUS)) {
    dot.remove_style_class_name(`letitcook-dot-${st}`);
  }
  dot.add_style_class_name('letitcook-dot-unknown');
  label.text = 'LetItCook';

  assert.strictEqual(container.get_n_children(), 2, 'Container child count remains 2 when 0 sessions');
  assert.strictEqual(label.text, 'LetItCook', 'Label returns to LetItCook');
}

function testStylesheetSingleDotDesign() {
  const css = fs.readFileSync(path.resolve('extension/stylesheet.css'), 'utf8');

  // Verify dot is a 10px circular element
  assert.ok(/width:\s*10px;/.test(css), 'Dot must have width 10px');
  assert.ok(/height:\s*10px;/.test(css), 'Dot must have height 10px');
  assert.ok(/border-radius:\s*5px;/.test(css), 'Dot must have border-radius 5px for circle');

  // Ensure no pseudo-elements creating duplicate visual dots
  assert.strictEqual(/::before/.test(css), false, 'Must not use ::before');
  assert.strictEqual(/::after/.test(css), false, 'Must not use ::after');

  // Ensure label does not define any circular background or border
  const labelBlockMatch = css.match(/\.letitcook-label\s*\{([^}]+)\}/);
  assert.ok(labelBlockMatch, '.letitcook-label CSS rule must exist');
  const labelBlock = labelBlockMatch[1];
  assert.strictEqual(/border-radius/.test(labelBlock), false, 'Label must not have border-radius');
  assert.strictEqual(/background/.test(labelBlock), false, 'Label must not have background');
}

function testNotificationIntegrationParity() {
  const targets = ['extension/extension.js', 'extension-legacy/extension.js'];

  for (const target of targets) {
    const code = fs.readFileSync(path.resolve(target), 'utf8');

    assert.ok(code.includes('_checkNotifications(sessions)'), `${target} must define _checkNotifications`);
    assert.ok(code.includes('_loadNotifyCache()'), `${target} must define _loadNotifyCache`);
    assert.ok(code.includes('_saveNotifyCache('), `${target} must define _saveNotifyCache`);
    assert.ok(code.includes('_lastSavedCacheJson'), `${target} must track _lastSavedCacheJson to avoid idle writes`);
    assert.ok(code.includes('Main.notify('), `${target} must call Main.notify`);
    assert.ok(code.includes('PopupSwitchMenuItem'), `${target} must include PopupSwitchMenuItem for Done toggle`);
    assert.ok(code.includes("'Notify on Done'"), `${target} must include 'Notify on Done' menu toggle`);
    assert.ok(code.includes('notify_cache.json'), `${target} must use notify_cache.json`);
    const updateStart = code.indexOf('    _update() {');
    const updateEnd = code.indexOf('\n    _rebuildMenu()', updateStart);
    assert.notStrictEqual(updateStart, -1, `${target} must define _update()`);
    assert.notStrictEqual(updateEnd, -1, `${target} must define _rebuildMenu()`);
    const update = code.slice(updateStart, updateEnd);
    const notificationIndex = update.indexOf('this._checkNotifications(sessions)');
    const cleanupIndex = update.indexOf('if (s.terminated && s.filePath)');
    assert.ok(update.includes('this._currentSessions = sessions;'),
      `${target} must keep terminal states visible during the update that evaluates them`);
    assert.ok(notificationIndex >= 0 && cleanupIndex > notificationIndex,
      `${target} must evaluate notifications before cleaning up terminal session files`);
  }
}

function testPackagingBothTargets() {
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-pack-test-'));
  try {
    const modernZip = path.join(tmpOut, 'modern');
    const legacyZip = path.join(tmpOut, 'legacy');
    fs.mkdirSync(modernZip);
    fs.mkdirSync(legacyZip);

    try {
      execFileSync('gnome-extensions', ['pack', '--force', `--out-dir=${modernZip}`, 'extension'], { stdio: 'ignore' });
      const modernFiles = fs.readdirSync(modernZip);
      assert.ok(modernFiles.some(f => f.endsWith('.shell-extension.zip')), 'Modern extension must pack into zip bundle');

      execFileSync('gnome-extensions', ['pack', '--force', `--out-dir=${legacyZip}`, 'extension-legacy'], { stdio: 'ignore' });
      const legacyFiles = fs.readdirSync(legacyZip);
      assert.ok(legacyFiles.some(f => f.endsWith('.shell-extension.zip')), 'Legacy extension must pack into zip bundle');
    } catch (e) {
      // If gnome-extensions is not in environment, skip packaging check gracefully
      if (e.code === 'ENOENT') return;
      throw e;
    }
  } finally {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
}

// --- Behavioural parity: execute the real extension methods -------------------
// GJS modules cannot load under Node, so method bodies are extracted from each
// extension variant and run against fakes, then compared with the Node reference
// implementations (normalizeSession / NotificationTracker) used by the test suite.
const EXTENSION_TARGETS = ['extension', 'extension-legacy'];

function extractMethod(code, name, target) {
  const match = code.match(new RegExp(`\\n    ${name}\\((\\w*)\\) \\{\\n([\\s\\S]*?)\\n    \\}\\n`));
  assert.ok(match, `${target}: ${name} not found`);
  return { param: match[1], body: match[2] };
}

function extractConst(code, name, target) {
  const match = code.match(new RegExp(`\\nconst ${name} = ([^;]+);`));
  assert.ok(match, `${target}: const ${name} not found`);
  return new Function('STATUS', `return (${match[1]});`)(STATUS);
}

function loadExtensionMethod(target, name, deps) {
  const code = fs.readFileSync(path.resolve(`${target}/extension.js`), 'utf8');
  const { param, body } = extractMethod(code, name, target);
  const consts = {
    STATUS,
    STATUS_META: extractConst(code, 'STATUS_META', target),
    STALE_TIMEOUT_MS: extractConst(code, 'STALE_TIMEOUT_MS', target),
  };
  const retention = code.match(/\nconst DEAD_SESSION_RETENTION_MS = ([^;]+);/);
  if (retention) consts.DEAD_SESSION_RETENTION_MS = new Function(`return (${retention[1]});`)();
  const all = { ...consts, console: { error() {} }, log() {}, ...deps };
  const names = Object.keys(all);
  return new Function(...names, `return function ${name}(${param}) {\n${body}\n};`)(...names.map(n => all[n]));
}

// Top-level notification helpers of a variant (shortCwd uses the real home directory).
const NOTIFICATION_HELPERS = [
  'shortCwd', 'notificationFirstLine', 'boundNotificationText', 'openQuote', 'redactNotificationSecrets',
  'cleanNotificationText', 'notificationReason', 'formatNotificationBody', 'formatSessionRow',
];
function loadExtensionNotificationHelpers(target) {
  const code = fs.readFileSync(path.resolve(`${target}/extension.js`), 'utf8');
  const consts = ['NOTIFY_SUBJECT_MAX', 'NOTIFY_REASON_MAX', 'NOTIFY_INPUT_MAX', 'SECRET_KEY_RE'].map((name) => {
    const match = code.match(new RegExp(`\\nconst ${name} = [^\\n]+`));
    assert.ok(match, `${target}: const ${name} not found`);
    return match[0];
  });
  const functions = NOTIFICATION_HELPERS.map((name) => {
    const match = code.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
    assert.ok(match, `${target}: function ${name} not found`);
    return match[0];
  });
  const GLib = { get_home_dir: () => os.homedir() };
  return new Function('STATUS', 'GLib', `${consts.join('')}${functions.join('')}\nreturn { ${NOTIFICATION_HELPERS.join(', ')} };`)(STATUS, GLib);
}

function runExtensionReadSession(target, raw, pidAlive) {
  const Gio = {
    FileQueryInfoFlags: { NONE: 0, NOFOLLOW_SYMLINKS: 1 },
    FileType: { REGULAR: 1, DIRECTORY: 2, SYMBOLIC_LINK: 3 },
    File: {
      new_for_path: () => ({
        enumerate_children: () => {
          let done = false;
          return {
            next_file: () => (done ? null : (done = true, { get_name: () => 'ses_x.json', get_file_type: () => 1 })),
            close() {},
          };
        },
        load_contents: () => [true, new TextEncoder().encode(JSON.stringify(raw))],
      }),
    },
  };
  const GLib = {
    build_filenamev: parts => parts.join('/'),
    file_test: () => pidAlive,
    FileTest: { EXISTS: 1 },
  };
  const fn = loadExtensionMethod(target, '_readSessions', { Gio, GLib });
  const result = fn.call({ _stateDir: '/fake' });
  assert.strictEqual(result.length, 1);
  return result[0];
}

function testExtensionLifecycleParityWithNode() {
  const now = Date.now();
  const ages = [10 * 1000, 10 * 60 * 1000, 2 * 60 * 60 * 1000];
  for (const target of EXTENSION_TARGETS) {
    for (const status of Object.values(STATUS)) {
      for (const pidAlive of [true, false, 'none']) {
        for (const age of ages) {
          const raw = { session_id: 'ses_x', agent: 'opencode', status, updated_at: now - age };
          if (pidAlive !== 'none') raw.pid = 4242;
          const ext = runExtensionReadSession(target, raw, pidAlive);
          const ref = normalizeSession(raw, { now, isPidAlive: () => pidAlive });
          const label = `${target}: ${status} pidAlive=${pidAlive} age=${age}`;
          assert.strictEqual(ext.status, ref.status, `${label}: status`);
          assert.strictEqual(ext.stale, ref.stale, `${label}: stale`);
          assert.strictEqual(ext.terminated, ref.terminated, `${label}: terminated`);
          assert.notStrictEqual(ext.status === STATUS.DONE && status !== STATUS.DONE, true, `${label}: never invents Done`);
        }
      }
    }
  }
}

function makeExtensionNotifier(target, notifyDone, { failing = false } = {}) {
  const notified = [];
  const errors = [];
  const Main = { notify: (title, body) => { if (failing) throw new Error('notification daemon unavailable'); notified.push({ title, body }); } };
  const logger = message => errors.push(String(message));
  const fn = loadExtensionMethod(target, '_checkNotifications', {
    Main, ...loadExtensionNotificationHelpers(target), console: { error: logger }, log: logger,
  });
  const self = {
    _notifyCache: { _config: { notifyDone }, sessions: {} },
    _notifyDone: notifyDone,
    _isFirstScan: true,
    _saveNotifyCache() {},
  };
  return {
    scan(sessions) {
      const before = notified.length;
      fn.call(self, sessions);
      return notified.slice(before);
    },
    errors,
    cache: () => self._notifyCache.sessions,
  };
}

// A popup that fails to show is not recorded as notified (no false delivery evidence) and
// is not retried on every scan.
function testFailedNotificationIsNotRecordedAsDelivered() {
  for (const target of EXTENSION_TARGETS) {
    const ext = makeExtensionNotifier(target, false, { failing: true });
    const session = status => ({ session_id: 'f', agent: 'opencode', status, title: 'T', cwd: '', reason: 'permission.asked:bash:rm x' });
    ext.scan([session(STATUS.COOKING)]);
    ext.scan([session(STATUS.YOUR_TURN)]);
    assert.strictEqual(ext.cache().f.notifiedStatus, null, `${target}: failed popup not recorded as notified`);
    assert.strictEqual(ext.cache().f.lastStatus, STATUS.YOUR_TURN, `${target}: last status advances`);
    assert.strictEqual(ext.errors.length, 1, `${target}: failure logged once`);
    assert.ok(!ext.errors[0].includes('rm x'), `${target}: log does not contain the notification text`);
    ext.scan([session(STATUS.YOUR_TURN)]);
    assert.strictEqual(ext.errors.length, 1, `${target}: not retried on every scan`);
  }
}

// Untrusted reasons as adapters produce them: error messages with stack traces, commands
// with credentials, private paths, terminal control sequences and output dumps.
const HOSTILE_REASONS = {
  [STATUS.BURN]: 'error:Model not found: aimurah/claude-sonnet-4.6.\n    at <anonymous> (/$bunfs/root/chunk-asxe09sd.js:439:94416)\n    at SessionPrompt.getModel (/$bunfs/root/chunk-v9f2av04.js:1142:11505)',
  [STATUS.YOUR_TURN]: 'permission.asked:bash:curl -H "Authorization: Bearer sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c" https://api.example.com/v1/deploy',
  cmd: 'permission.asked:bash:export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 && ./deploy.sh',
};

const SANITIZATION_CORPUS = [
  ['stack trace', 'error:Model not found: aimurah/claude-sonnet-4.6.\n    at <anonymous> (/$bunfs/root/chunk-asxe09sd.js:439:94416)\n    at x (/home/alice/app.js:1:1)'],
  ['bearer + url', 'permission.asked:bash:curl -H "Authorization: Bearer sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c" https://user:hunter2@api.example.com/v1/deploy?key=abc'],
  ['env secret', 'permission.asked:bash:export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 && ./deploy.sh'],
  ['flag secret', 'error:mysql --password hunter2 --token "two words" failed'],
  ['private path', "error:ENOENT: no such file or directory, open '/home/alice/clients/acme/secrets/.env.production'"],
  ['home path', 'error:cannot read ~/clients/acme/notes/prompt.txt'],
  ['control chars', 'error:\u001b[31mfailed\u001b[0m\u0007 with\tbell\u0000 and \u009b8 C1'],
  ['long output', `error:${'very long output line '.repeat(40)}`],
  ['carriage return', 'error:first line\rsecond line with password=hunter2'],
  ['question', 'question.asked:permission requested'],
  ['plain', 'permission needed'],
  ['benign words', 'error:max tokens per minute: 5000; secret sauce is fine'],
  ['bidi spoof', 'error:file \u202eexe.txt\u202c and zero\u200bwidth \u2066x\u2069'],
  ['multilingual', 'error:ملف غير موجود — 文件未找到 — फ़ाइल नहीं मिली — می\u200cخواهم 👩\u200d💻'],
  ['prefixed key', 'error:error:token=hunter2tok:def and PGPASSWORD=hunter2pg'],
  ['spaced key', 'error:password = hunter2spaced and cookie: hunter2cookie; Path=/'],
  ['empty', ''],
  ['non-string', 42],
];
const SECRETS = ['\u202e', '\u200b', '\u2066', 'sk-live', 'sk-proj', 'hunter2', 'hunter2tok', 'hunter2pg', 'hunter2spaced', 'hunter2cookie', 'two words', '/home/alice', 'clients/acme', 'SessionPrompt', 'bunfs', 'second line', 'v1/deploy', 'key=abc'];

function testNotificationSanitizationParity() {
  for (const target of EXTENSION_TARGETS) {
    const helpers = loadExtensionNotificationHelpers(target);
    for (const status of [STATUS.YOUR_TURN, STATUS.BURN, STATUS.DONE]) {
      for (const [label, reason] of SANITIZATION_CORPUS) {
        for (const subject of [{ title: 'Deploy' }, { title: '', cwd: '/srv/app' }, { title: 'line one\nline two \u001b[1mbold' }]) {
          const session = { agent: 'opencode', status, reason, ...subject };
          const ref = formatNotification(session);
          const body = helpers.formatNotificationBody(session);
          const name = `${target} ${status} ${label} ${JSON.stringify(subject)}`;
          assert.strictEqual(body, ref.body, `${name}: full body matches the Node reference`);
          assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(body), `${name}: no control characters`);
          assert.ok(body.length <= 200, `${name}: bounded length (${body.length})`);
          for (const secret of SECRETS) assert.ok(!body.includes(secret), `${name}: does not expose "${secret}": ${body}`);
        }
      }
    }
  }

  // The reference keeps a useful short explanation.
  const yt = formatNotification({ agent: 'opencode', status: STATUS.YOUR_TURN, title: 'Deploy', reason: SANITIZATION_CORPUS[1][1] });
  assert.strictEqual(yt.body, 'Your Turn (permission.asked:bash) • Deploy');
  const burn = formatNotification({ agent: 'opencode', status: STATUS.BURN, title: 'Deploy', reason: SANITIZATION_CORPUS[0][1] });
  assert.strictEqual(burn.body, 'Burn: error:Model not found: aimurah/claude-sonnet-4.6. • Deploy');
  const path = formatNotification({ agent: 'opencode', status: STATUS.BURN, title: 'Deploy', reason: SANITIZATION_CORPUS[4][1] });
  assert.strictEqual(path.body, "Burn: error:ENOENT: no such file or directory, open '…/.env.production' • Deploy");
  const benign = formatNotification({ agent: 'opencode', status: STATUS.BURN, title: 'Deploy', reason: SANITIZATION_CORPUS[11][1] });
  assert.strictEqual(benign.body, 'Burn: error:max tokens per minute: 5000; secret sauce is fine • Deploy', 'ordinary words are not redacted');
  const bidi = formatNotification({ agent: 'opencode', status: STATUS.BURN, title: 'Deploy', reason: 'error:file \u202eexe.txt\u202c and zero\u200bwidth' });
  assert.strictEqual(bidi.body, 'Burn: error:file exe.txt and zerowidth • Deploy', 'direction overrides and zero-width spaces removed');
  const multilingual = 'error:ملف غير موجود — 文件未找到 — फ़ाइल नहीं मिली — می\u200cخواهم 👩\u200d💻';
  assert.strictEqual(formatNotification({ agent: 'opencode', status: STATUS.BURN, reason: multilingual }).body, `Burn: ${multilingual} • global`, 'multilingual text, ZWNJ and ZWJ emoji kept');
  const cwd = formatNotification({ agent: 'opencode', status: STATUS.DONE, cwd: '/srv/app' });
  assert.strictEqual(cwd.body, 'Done • /srv/app', 'project identifier is kept');
}

// R1: the sanitizer runs on GNOME Shell's main thread. Every implementation must only
// ever process a bounded prefix, whatever the input length.
function notificationImplementations() {
  const node = {
    body: session => formatNotification(session).body,
    title: session => formatNotification(session).title,
  };
  const variants = EXTENSION_TARGETS.map((target) => {
    const helpers = loadExtensionNotificationHelpers(target);
    return [target, {
      body: session => helpers.formatNotificationBody(session),
      title: session => `LetItCook: ${helpers.cleanNotificationText(session.agent || 'Agent', 32) || 'Agent'}`,
    }];
  });
  return [['node', node], ...variants];
}

const PATHOLOGICAL_LINES = {
  'word characters': 'a'.repeat(100000),
  'dash-separated': '-ab'.repeat(34000),
  'provider JSON body': JSON.stringify({ error: { message: 'x'.repeat(100000) } }),
  'path segments': '/abc'.repeat(25000),
  'dotted host': 'a.'.repeat(50000),
  'colons': 'token:'.repeat(17000),
  'equals': 'key='.repeat(25000),
  'ANSI codes': '\u001b[0m'.repeat(25000),
  'open quotes': 'password="x '.repeat(9000),
  'many words': 'ordinary word '.repeat(7200),
};

function testNotificationSanitizerIsBounded() {
  for (const [impl, format] of notificationImplementations()) {
    for (const [label, line] of Object.entries(PATHOLOGICAL_LINES)) {
      for (const status of [STATUS.BURN, STATUS.YOUR_TURN]) {
        const session = { agent: line, status, reason: `error:${line}`, title: line };
        // Deterministic check: nothing past the bound can influence the output.
        const short = { agent: line.slice(0, 600), status, reason: `error:${line}`.slice(0, 600), title: line.slice(0, 600) };
        assert.strictEqual(format.body(session), format.body(short), `${impl} ${label} ${status}: output depends only on the bounded prefix`);
        assert.strictEqual(format.title(session), format.title(short), `${impl} ${label}: title bounded`);
        // Timing check with a generous threshold (unbounded input took 32 s at 100 KB).
        let best = Infinity;
        for (let i = 0; i < 3; i++) {
          const started = process.hrtime.bigint();
          format.body(session);
          format.title(session);
          best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
        }
        assert.ok(best < 50, `${impl} ${label} ${status}: 100 KB line formatted in ${best.toFixed(1)} ms (limit 50 ms)`);
      }
    }
  }
}

// A secret straddling the input cutoff must not be partly shown. The line is cut at the
// last whitespace before NOTIFY_INPUT_MAX, so the straddling word is dropped entirely.
// A prefix of ANSI codes shrinks to nothing when cleaned, so the cut region really
// reaches the visible text. Every secret value starts with the marker `Zq9`.
function testSecretsAtTheCutoffAreDropped() {
  const invisible = '\u001b[0m'.repeat(120); // 480 characters, empty after cleaning
  const lead = `error:${invisible}ok `; // 489 characters
  const cases = {
    'unlabelled long key': `Zq9${'k'.repeat(60)}`,
    'key=value': `password=Zq9${'v'.repeat(40)}`,
    'bearer value': `Bearer Zq9${'b'.repeat(40)}`,
    'flag value': `--token Zq9${'f'.repeat(40)}`,
    'quoted value': `token="Zq9 ${'q'.repeat(40)}"`,
  };
  for (const [impl, format] of notificationImplementations()) {
    for (const [label, secret] of Object.entries(cases)) {
      for (const before of [1, 2, 5, 10, 20]) {
        // The secret starts `before` characters ahead of the cut (NOTIFY_INPUT_MAX - 2 = 510).
        const pad = 510 - before - lead.length - 1;
        const reason = `${lead}${'y'.repeat(pad)} ${secret} trailing words`;
        assert.strictEqual(reason.indexOf(secret), 510 - before, 'test setup: secret straddles the cut');
        const body = format.body({ agent: 'opencode', status: STATUS.BURN, reason, title: 'Deploy' });
        assert.ok(!body.includes('Zq9') && !body.includes('Zq'), `${impl} ${label} ${before} before cut: no secret fragment: ${body}`);
        assert.ok(body.includes('…'), `${impl} ${label} ${before} before cut: truncation is marked: ${body}`);
      }
    }
  }
  // A secret fully inside the bound is still redacted, not dropped.
  assert.strictEqual(cleanNotificationText(`${'\u001b[0m'.repeat(100)}password=hunter2 ok`, 80), 'password=[redacted] ok');
}

function testMalformedNotificationInputs() {
  for (const [impl, format] of notificationImplementations()) {
    for (const value of [undefined, null, 0, 42, true, {}, [], ['a'], { toString: () => 'password=hunter2' }]) {
      const session = { agent: value, status: STATUS.BURN, reason: value, title: value, cwd: '' };
      const body = format.body(session);
      assert.strictEqual(typeof body, 'string', `${impl} ${String(value)}: body is a string`);
      assert.ok(!body.includes('hunter2'), `${impl}: object toString is never used`);
      assert.match(format.title(session), /^LetItCook: /, `${impl}: title stays well-formed`);
    }
  }
}

// R2: dropdown rows use the same cleaning as popups.
function testMenuRowsAreSanitized() {
  const meta = { emoji: '🔴', label: 'Burn' };
  for (const target of EXTENSION_TARGETS) {
    const { formatSessionRow } = loadExtensionNotificationHelpers(target);
    for (const status of [STATUS.YOUR_TURN, STATUS.BURN, STATUS.COOKING, STATUS.UNKNOWN]) {
      for (const [label, reason] of SANITIZATION_CORPUS) {
        const row = formatSessionRow({ agent: 'opencode\u202e', status, reason, title: 'line one\nline two', cwd: '/srv/app' }, meta, '5s ago');
        const text = `${row.title}\n${row.subtitle}`;
        assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/.test(text), `${target} ${status} ${label}: no control characters`);
        assert.ok(row.subtitle.length <= 160, `${target} ${status} ${label}: bounded subtitle`);
        for (const secret of SECRETS) assert.ok(!text.includes(secret), `${target} ${status} ${label}: does not show "${secret}": ${text}`);
      }
    }
    const yt = formatSessionRow({ agent: 'opencode', status: STATUS.YOUR_TURN, reason: SANITIZATION_CORPUS[1][1], title: 'Deploy', cwd: '/srv/app' }, { emoji: '🟠', label: 'Your Turn' }, '1m ago');
    assert.deepStrictEqual(yt, { title: '🟠 [opencode] Deploy', subtitle: 'Your Turn: permission.asked:bash • 1m ago • /srv/app' });
    const plain = formatSessionRow({ agent: 'copilot', status: STATUS.COOKING, reason: 'tool:bash:executing', title: '', cwd: '' }, { emoji: '🟡', label: 'Cooking' }, '2s ago');
    assert.deepStrictEqual(plain, { title: '🟡 [copilot] global', subtitle: 'Cooking: tool:bash:executing • 2s ago' }, 'ordinary rows unchanged');
  }
}

function testExtensionNotificationParityWithTracker() {
  const s = (session_id, status, extra = {}) => ({ session_id, agent: 'opencode', status, title: 'T', cwd: '', reason: HOSTILE_REASONS[session_id === 'a' ? status : 'cmd'] || '', ...extra });
  const scenarios = [
    // [notifyDone, steps]
    [false, [
      [s('a', STATUS.YOUR_TURN)],                 // first scan: suppressed
      [s('a', STATUS.COOKING)],
      [s('a', STATUS.YOUR_TURN)],                 // notify
      [s('a', STATUS.YOUR_TURN)],                 // dedup
      [s('a', STATUS.COOKING)],
      [s('a', STATUS.YOUR_TURN)],                 // genuine repeat: notify
      [s('a', STATUS.BURN)],                      // notify
      [s('a', STATUS.COOKING), s('b', STATUS.COOKING)],
      [s('a', STATUS.DONE), s('b', STATUS.BURN)], // Done opted out; b notifies
    ]],
    [true, [
      [s('a', STATUS.COOKING), s('b', STATUS.UNKNOWN)],
      [s('a', STATUS.DONE), s('b', STATUS.DONE)], // a: Cooking->Done notifies; b: Unknown->Done never
      [s('a', STATUS.DONE), s('b', STATUS.DONE)],
      [s('a', STATUS.COOKING)],
      [s('a', STATUS.DONE)],                      // subsequent completion notifies again
      [s('a', STATUS.YOUR_TURN)],
      [s('a', STATUS.DONE)],                      // Your Turn -> Done is untrustworthy
      [s('a', STATUS.COOKING)],
      [s('a', STATUS.YOUR_TURN, { stale: true })],
      [s('a', STATUS.BURN, { confidence: 'low' })],
    ]],
  ];

  for (const target of EXTENSION_TARGETS) {
    for (const [notifyDone, steps] of scenarios) {
      const ext = makeExtensionNotifier(target, notifyDone);
      const ref = new NotificationTracker({ notifyDone });
      steps.forEach((sessions, i) => {
        const got = ext.scan(sessions);
        const want = ref.processSessions(sessions);
        assert.strictEqual(got.length, want.length, `${target} notifyDone=${notifyDone} step ${i}: notification count`);
        want.forEach((w, j) => {
          assert.strictEqual(got[j].title, w.title, `${target} step ${i}: title`);
          assert.strictEqual(got[j].body, w.body, `${target} step ${i}: full body`);
        });
      });
    }
  }
}

function run() {
  testModernMetadataCompatibility();
  testLegacyMetadataCompatibility();
  testModernExtensionESMSyntax();
  testLegacyExtensionSyntax();
  testExtensionStatusModelParity();
  testStylesheetParity();
  testSingleDotPanelFormatting();
  testDropdownMenuRetainsEmojis();
  testPanelActorHierarchyAndLifecycle();
  testStylesheetSingleDotDesign();
  testNotificationIntegrationParity();
  testPackagingBothTargets();
  testExtensionLifecycleParityWithNode();
  testExtensionNotificationParityWithTracker();
  testNotificationSanitizationParity();
  testMenuRowsAreSanitized();
  testFailedNotificationIsNotRecordedAsDelivered();
  testNotificationSanitizerIsBounded();
  testSecretsAtTheCutoffAreDropped();
  testMalformedNotificationInputs();
  console.log('All LetItCook GNOME extension compatibility tests passed.');
}

run();
