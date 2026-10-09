import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
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

function run() {
  testModernMetadataCompatibility();
  testLegacyMetadataCompatibility();
  testModernExtensionESMSyntax();
  testLegacyExtensionSyntax();
  testExtensionStatusModelParity();
  testStylesheetParity();
  console.log('All LetItCook GNOME extension compatibility tests passed.');
}

run();
