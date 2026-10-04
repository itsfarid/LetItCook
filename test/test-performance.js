import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LetItCookPlugin } from '../src/adapters/opencode/plugin.js';
import { STATUS, aggregateState } from '../src/core/status.js';
import {
  getWriteCount,
  resetWriteCount,
  readAllSessionsFromDir,
  hasMeaningfulStateChange,
} from '../src/adapters/opencode/adapter.js';

class MockDebouncer {
  constructor(delayMs, callback) {
    this.delayMs = delayMs;
    this.callback = callback;
    this.timer = null;
    this.cancelledCount = 0;
    this.executedCount = 0;
  }

  trigger() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.cancelledCount++;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.executedCount++;
      this.callback();
    }, this.delayMs);
  }

  destroy() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.cancelledCount++;
    }
  }
}

class MockIndicator {
  constructor() {
    this.menu = {
      isOpen: false,
      rebuildCount: 0,
    };
    this.updateCount = 0;
    this.indicatorUpdateCount = 0;
  }

  _update(sessions = []) {
    this.updateCount++;
    this.indicatorUpdateCount++;

    if (this.menu.isOpen) {
      this._rebuildMenu();
    }
  }

  _rebuildMenu() {
    this.menu.rebuildCount++;
  }

  openMenu() {
    this.menu.isOpen = true;
    this._rebuildMenu();
  }

  closeMenu() {
    this.menu.isOpen = false;
  }
}

async function testStreamingDeduplicationSingleSession() {
  const tmpDir = path.join(os.tmpdir(), `letitcook_perf_single_${Date.now()}`);
  process.env.LETITCOOK_STATE_DIR = tmpDir;
  resetWriteCount();

  try {
    const plugin = await LetItCookPlugin({});

    // 1. Session created
    await plugin.event({
      event: {
        type: 'session.created',
        properties: { sessionID: 'perf_ses_1', directory: '/home/user/app', title: 'Perf App' },
      },
    });
    assert.strictEqual(getWriteCount(), 1, 'session.created should trigger 1 write');

    // 2. Stream 500 message.updated events
    for (let i = 0; i < 500; i++) {
      await plugin.event({
        event: {
          type: 'message.updated',
          properties: {
            sessionID: 'perf_ses_1',
            role: 'assistant',
            chunk: `token_${i}`,
          },
        },
      });
    }

    // Only 1 write for the initial transition to 'assistant working', 0 writes for remaining 499
    assert.strictEqual(
      getWriteCount(),
      2,
      `500 streaming updates should produce only 1 additional write (total 2), got ${getWriteCount()}`
    );

    // 3. Tool execution
    await plugin['tool.execute.before']({ sessionID: 'perf_ses_1', tool: 'bash' });
    assert.strictEqual(getWriteCount(), 3, 'tool.before should trigger 1 write');

    await plugin['tool.execute.after']({ sessionID: 'perf_ses_1', tool: 'bash' });
    assert.strictEqual(getWriteCount(), 4, 'tool.after should trigger 1 write');

    // 4. Session idle (done)
    await plugin.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'perf_ses_1' },
      },
    });
    assert.strictEqual(getWriteCount(), 5, 'session.idle should trigger 1 write');

    console.log(`Single session test: 500 streaming events produced ${getWriteCount()} total disk writes.`);
  } finally {
    delete process.env.LETITCOOK_STATE_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

async function testStreamingDeduplicationFiveSessions() {
  const tmpDir = path.join(os.tmpdir(), `letitcook_perf_multi_${Date.now()}`);
  process.env.LETITCOOK_STATE_DIR = tmpDir;
  resetWriteCount();

  try {
    const plugin = await LetItCookPlugin({});
    const sessionCount = 5;

    // Create 5 sessions
    for (let i = 1; i <= sessionCount; i++) {
      await plugin.event({
        event: {
          type: 'session.created',
          properties: { sessionID: `multi_ses_${i}`, directory: `/home/user/p${i}`, title: `Project ${i}` },
        },
      });
    }
    assert.strictEqual(getWriteCount(), 5, '5 sessions created = 5 writes');

    // Concurrently stream 100 message.updated per session (500 events total)
    for (let round = 0; round < 100; round++) {
      for (let s = 1; s <= sessionCount; s++) {
        await plugin.event({
          event: {
            type: 'message.updated',
            properties: {
              sessionID: `multi_ses_${s}`,
              role: 'assistant',
              chunk: `delta_${round}`,
            },
          },
        });
      }
    }

    // 5 initial 'assistant working' transitions = 5 writes; remaining 495 events = 0 writes
    assert.strictEqual(
      getWriteCount(),
      10,
      `500 streaming events across 5 sessions should produce only 5 additional writes (total 10), got ${getWriteCount()}`
    );

    const sessions = readAllSessionsFromDir(tmpDir);
    assert.strictEqual(sessions.length, 5);
    assert.strictEqual(aggregateState(sessions).status, STATUS.COOKING);

    console.log(`5 concurrent sessions: 500 streaming events produced ${getWriteCount()} total disk writes.`);
  } finally {
    delete process.env.LETITCOOK_STATE_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

async function testDebouncer() {
  let executed = 0;
  const debouncer = new MockDebouncer(50, () => {
    executed++;
  });

  // Burst 50 events in 10ms
  for (let i = 0; i < 50; i++) {
    debouncer.trigger();
  }

  assert.strictEqual(executed, 0, 'Should not execute immediately');
  assert.strictEqual(debouncer.cancelledCount, 49, '49 intermediate timers should be cancelled');

  await new Promise(r => setTimeout(r, 80));

  assert.strictEqual(executed, 1, 'Should execute exactly once after debounce delay');
  assert.strictEqual(debouncer.executedCount, 1);

  // Test destroy during active debounce
  debouncer.trigger();
  debouncer.destroy();
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(executed, 1, 'Destroyed debouncer must not execute scheduled callback');

  console.log('Debouncer burst test passed (50 burst events collapsed into 1 refresh).');
}

function testLazyMenuReconstruction() {
  const indicator = new MockIndicator();

  // 1. When closed: 100 state updates must produce 0 menu rebuilds
  for (let i = 0; i < 100; i++) {
    indicator._update();
  }

  assert.strictEqual(indicator.updateCount, 100);
  assert.strictEqual(indicator.menu.rebuildCount, 0, 'Menu must not be rebuilt when closed');

  // 2. Open menu: exactly 1 rebuild
  indicator.openMenu();
  assert.strictEqual(indicator.menu.rebuildCount, 1, 'Menu must rebuild when opened');

  // 3. Update while open: rebuilds to keep contents fresh
  indicator._update();
  assert.strictEqual(indicator.menu.rebuildCount, 2, 'Menu must rebuild on update while open');

  // 4. Close menu: subsequent updates do not rebuild
  indicator.closeMenu();
  for (let i = 0; i < 50; i++) {
    indicator._update();
  }
  assert.strictEqual(indicator.menu.rebuildCount, 2, 'Menu must not rebuild after closing');

  console.log('Lazy menu reconstruction test passed (0 menu rebuilds while closed).');
}

async function run() {
  await testStreamingDeduplicationSingleSession();
  await testStreamingDeduplicationFiveSessions();
  await testDebouncer();
  testLazyMenuReconstruction();
  console.log('All LetItCook performance tests passed successfully.');
}

run();
