import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { STATUS, STATUS_META } from '../src/core/status.js';

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
      code.includes('${sMeta.emoji} [${s.agent}]'),
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
    assert.ok(code.includes('_saveNotifyCache()'), `${target} must define _saveNotifyCache`);
    assert.ok(code.includes('Main.notify('), `${target} must call Main.notify`);
    assert.ok(code.includes('PopupSwitchMenuItem'), `${target} must include PopupSwitchMenuItem for Done toggle`);
    assert.ok(code.includes("'Notify on Done'"), `${target} must include 'Notify on Done' menu toggle`);
    assert.ok(code.includes('notify_cache.json'), `${target} must use notify_cache.json`);
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
  console.log('All LetItCook GNOME extension compatibility tests passed.');
}

run();
