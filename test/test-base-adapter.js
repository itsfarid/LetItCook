import assert from 'node:assert';
import { BaseAdapter } from '../src/adapters/base.js';

function testBaseAdapterBasic() {
  const adapter = new BaseAdapter('test-adapter', 'TestAdapter');
  assert.strictEqual(adapter.id, 'test-adapter');
  assert.strictEqual(adapter.name, 'TestAdapter');
}

function testBaseAdapterAbstractMethods() {
  const adapter = new BaseAdapter('test');

  assert.strictEqual(typeof adapter.isAvailable, 'function');
  assert.strictEqual(typeof adapter.detectSessions, 'function');
  assert.strictEqual(typeof adapter.getSessionState, 'function');
  assert.strictEqual(typeof adapter.normalizeState, 'function');
}

function testBaseAdapterInvalidId() {
  assert.throws(() => new BaseAdapter(null), Error, 'id is required');
  assert.throws(() => new BaseAdapter(''), Error, 'empty id is invalid');
  assert.throws(() => new BaseAdapter([]), Error, 'non-string id is invalid');
}

function testBaseAdapterNormalizeState() {
  const adapter = new BaseAdapter('opencode');

  const normalized = adapter.normalizeState({
    session_id: 'ses_1',
    status: 'cooking',
    reason: 'working',
    title: 'Test',
    cwd: '/tmp/test',
  });
  assert.strictEqual(normalized.agent, 'opencode');
  assert.strictEqual(normalized.session_id, 'ses_1');
}

function testBaseAdapterDefaultActions() {
  const adapter = new BaseAdapter('stub');

  assert.deepStrictEqual(adapter.detectSessions(), [], 'detectSessions returns empty array');
  assert.strictEqual(adapter.getSessionState('any'), null, 'getSessionState returns null for unknown session');
  assert.deepStrictEqual(adapter.startMonitoring(() => {}), undefined, 'startMonitoring returns undefined');
  adapter.stopMonitoring();

  // ponytail: ensure startMonitoring doesn't throw if callback is invalid
  try {
    adapter.startMonitoring(null);
    adapter.stopMonitoring();
  } catch (e) {
    throw e;
  }
}

function run() {
  testBaseAdapterBasic();
  testBaseAdapterAbstractMethods();
  testBaseAdapterInvalidId();
  testBaseAdapterNormalizeState();
  testBaseAdapterDefaultActions();
  console.log('All base adapter tests passed.');
}

run();