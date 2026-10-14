import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { STATUS } from '../src/core/status.js';
import { NotificationTracker } from '../src/core/notification.js';
import { runNotify } from '../src/notify.js';
import { writeSessionFile, readAllSessionsFromDir } from '../src/adapters/opencode/adapter.js';

function testFilesystemNotificationFlow() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-notify-int-'));
  const sessionDir = path.join(tmpDir, 'sessions');
  const cachePath = path.join(tmpDir, 'notify_cache.json');
  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    const tracker = new NotificationTracker({
      cachePath,
      notifyDone: false,
      suppressInitial: true,
    });

    // 1. Initial agent startup in cooking
    writeSessionFile({
      session_id: 'sess-1',
      agent: 'opencode',
      status: STATUS.COOKING,
      title: 'Fix issue #12',
      cwd: '/tmp/repo',
      updated_at: Date.now(),
    }, sessionDir);

    let sessions = readAllSessionsFromDir(sessionDir);
    let events = tracker.processSessions(sessions);
    assert.strictEqual(events.length, 0, 'No notification on startup cooking');

    // 2. Transition: Agent enters your_turn
    writeSessionFile({
      session_id: 'sess-1',
      agent: 'opencode',
      status: STATUS.YOUR_TURN,
      title: 'Fix issue #12',
      reason: 'Confirm file write',
      cwd: '/tmp/repo',
      updated_at: Date.now(),
    }, sessionDir);

    sessions = readAllSessionsFromDir(sessionDir);
    events = tracker.processSessions(sessions);
    assert.strictEqual(events.length, 1, 'Exactly one notification on your_turn');
    assert.strictEqual(events[0].urgency, 'high');
    assert.ok(events[0].body.includes('Confirm file write'));

    // 3. Simulating 50 burst writes of same status (streaming tool output / poll loop)
    for (let i = 0; i < 50; i++) {
      writeSessionFile({
        session_id: 'sess-1',
        agent: 'opencode',
        status: STATUS.YOUR_TURN,
        title: 'Fix issue #12',
        reason: 'Confirm file write',
        cwd: '/tmp/repo',
        updated_at: Date.now() + i,
      }, sessionDir);

      sessions = readAllSessionsFromDir(sessionDir);
      events = tracker.processSessions(sessions);
      assert.strictEqual(events.length, 0, `Burst write ${i} must produce 0 duplicate notifications`);
    }

    // 4. Extension reload / GNOME Shell restart simulation
    const reloadedTracker = new NotificationTracker({
      cachePath,
      notifyDone: false,
      suppressInitial: false,
    });
    sessions = readAllSessionsFromDir(sessionDir);
    events = reloadedTracker.processSessions(sessions);
    assert.strictEqual(events.length, 0, 'Reloading extension with persisted cache must not re-notify');

    // 5. Agent resumes cooking, then burns
    writeSessionFile({
      session_id: 'sess-1',
      agent: 'opencode',
      status: STATUS.COOKING,
      updated_at: Date.now(),
    }, sessionDir);
    sessions = readAllSessionsFromDir(sessionDir);
    events = reloadedTracker.processSessions(sessions);
    assert.strictEqual(events.length, 0, 'Resumed cooking produces 0 notifications');

    writeSessionFile({
      session_id: 'sess-1',
      agent: 'opencode',
      status: STATUS.BURN,
      reason: 'Out of memory',
      updated_at: Date.now(),
    }, sessionDir);
    sessions = readAllSessionsFromDir(sessionDir);
    events = reloadedTracker.processSessions(sessions);
    assert.strictEqual(events.length, 1, 'Burn transition must notify');
    assert.strictEqual(events[0].urgency, 'critical');

    // 6. Opt-in Done verification
    const doneTracker = new NotificationTracker({
      cachePath,
      notifyDone: true,
      suppressInitial: false,
    });
    // Session 2 starts cooking
    writeSessionFile({
      session_id: 'sess-2',
      agent: 'copilot',
      status: STATUS.COOKING,
      updated_at: Date.now(),
    }, sessionDir);
    sessions = readAllSessionsFromDir(sessionDir);
    doneTracker.processSessions(sessions);

    // Session 2 completes successfully
    writeSessionFile({
      session_id: 'sess-2',
      agent: 'copilot',
      status: STATUS.DONE,
      title: 'Build passed',
      updated_at: Date.now(),
    }, sessionDir);
    sessions = readAllSessionsFromDir(sessionDir);
    const doneEvents = doneTracker.processSessions(sessions);
    assert.strictEqual(doneEvents.length, 1, 'Opt-in Done must notify when transitioning from cooking');
    assert.strictEqual(doneEvents[0].urgency, 'normal');

    // 7. Untrustworthy / corrupt session file: must NOT notify
    fs.writeFileSync(path.join(sessionDir, 'corrupt.json'), '{ invalid json @@', 'utf8');
    sessions = readAllSessionsFromDir(sessionDir);
    const corruptEvents = doneTracker.processSessions(sessions);
    assert.strictEqual(corruptEvents.length, 0, 'Corrupt session file must never trigger notification');

    // 8. CLI integration check: verify runNotify() runs one-shot against directory
    const cliOutput = runNotify({
      sessionDir,
      cachePath,
      notifyDone: true,
      suppressInitial: false,
    });
    assert.strictEqual(cliOutput.ok, true);
    assert.strictEqual(cliOutput.owner, 'gnome-extension');
    assert.strictEqual(typeof cliOutput.sessionsCount, 'number');

    // 9. CLI dispatch unsupported check: runNotify with dispatch:true fails safely
    const refusedDispatch = runNotify({
      sessionDir,
      cachePath,
      dispatch: true,
    });
    assert.strictEqual(refusedDispatch.ok, false);
    assert.ok(refusedDispatch.error.includes('unsupported'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testCliProcessExecution() {
  const notifyScript = path.resolve('src/notify.js');

  // Default one-shot runs cleanly with exit 0 and outputs valid JSON
  const stdout = execFileSync('node', [notifyScript], { encoding: 'utf8' });
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.owner, 'gnome-extension');

  // --dispatch must exit non-zero (exit code 1) to prevent competing dispatch
  let dispatchFailed = false;
  try {
    execFileSync('node', [notifyScript, '--dispatch'], { stdio: 'pipe' });
  } catch (err) {
    dispatchFailed = true;
    assert.strictEqual(err.status, 1, '--dispatch must exit with code 1');
    const stderr = err.stderr ? err.stderr.toString() : '';
    assert.ok(stderr.includes('unsupported'), 'Error output must state that dispatch is unsupported');
  }
  assert.strictEqual(dispatchFailed, true, '--dispatch must fail execution');
}

function makeIsolatedState() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-readonly-'));
  const sessionDir = path.join(tmpDir, 'sessions');
  const stateHome = path.join(tmpDir, 'state');
  const cachePath = path.join(stateHome, 'letitcook', 'notify_cache.json');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  return { tmpDir, sessionDir, stateHome, cachePath };
}

function snapshot(cachePath) {
  return { content: fs.readFileSync(cachePath, 'utf8'), mtimeMs: fs.statSync(cachePath).mtimeMs };
}

function testCliInspectionIsReadOnly() {
  const { tmpDir, sessionDir, cachePath } = makeIsolatedState();
  try {
    // Cache says sess-1 was cooking and notifyDone is opted in; session now needs the user.
    fs.writeFileSync(cachePath, JSON.stringify({
      _config: { notifyDone: true },
      sessions: { 'sess-1': { lastStatus: STATUS.COOKING, notifiedStatus: null, updatedAt: 1 } },
    }, null, 2), 'utf8');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(cachePath, old, old);
    writeSessionFile({
      session_id: 'sess-1', agent: 'opencode', status: STATUS.YOUR_TURN,
      reason: 'Confirm', updated_at: Date.now(),
    }, sessionDir);

    const before = snapshot(cachePath);
    const dirListingBefore = fs.readdirSync(path.dirname(cachePath)).sort();

    // Repeated inspection reports the pending event every time and never consumes it.
    for (let i = 0; i < 3; i++) {
      const result = runNotify({ sessionDir, cachePath });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.dispatched, false);
      assert.strictEqual(result.eventsCount, 1, `inspection #${i} must still see the pending notification`);
      assert.strictEqual(result.notifyDone, true, 'persisted notifyDone is reported, not overwritten');
    }

    // One-off override and fresh-cache variants must not write either.
    runNotify({ sessionDir, cachePath, notifyDone: true });
    runNotify({ sessionDir, cachePath, suppressInitial: true });

    const after = snapshot(cachePath);
    assert.strictEqual(after.content, before.content, 'cache contents must be unchanged');
    assert.strictEqual(after.mtimeMs, before.mtimeMs, 'cache mtime must be unchanged');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(cachePath)).sort(), dirListingBefore, 'no temp files left');
    assert.strictEqual(JSON.parse(after.content)._config.notifyDone, true);

    // The extension (a writing tracker) can still deliver the notification afterwards.
    const extensionTracker = new NotificationTracker({ cachePath, suppressInitial: false });
    const delivered = extensionTracker.processSessions(readAllSessionsFromDir(sessionDir));
    assert.strictEqual(delivered.length, 1, 'extension must still deliver after CLI inspection');

    // And now that it was delivered, inspection reports nothing further.
    assert.strictEqual(runNotify({ sessionDir, cachePath }).eventsCount, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testCliInspectionWithoutCacheDoesNotCreateIt() {
  const { tmpDir, sessionDir, cachePath } = makeIsolatedState();
  try {
    writeSessionFile({
      session_id: 's', agent: 'opencode', status: STATUS.BURN, updated_at: Date.now(),
    }, sessionDir);
    const result = runNotify({ sessionDir, cachePath });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(fs.existsSync(cachePath), false, 'inspection must not create the cache');
    assert.strictEqual(result.notifyDone, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testCliProcessIsReadOnlyAndDispatchTest() {
  const { tmpDir, sessionDir, stateHome, cachePath } = makeIsolatedState();
  const notifyScript = path.resolve('src/notify.js');
  const env = { ...process.env, XDG_STATE_HOME: stateHome, HOME: tmpDir, XDG_DATA_HOME: path.join(tmpDir, 'data') };
  try {
    fs.writeFileSync(cachePath, JSON.stringify({ _config: { notifyDone: true }, sessions: {} }), 'utf8');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(cachePath, old, old);
    const before = snapshot(cachePath);

    for (const args of [[], ['--include-done']]) {
      const out = JSON.parse(execFileSync('node', [notifyScript, ...args], { encoding: 'utf8', env }));
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.cachePath, cachePath, 'CLI must use the isolated cache');
    }
    const after = snapshot(cachePath);
    assert.deepStrictEqual(after, before, 'CLI process must not touch the cache');

    // --dispatch still fails safely and does not touch the cache.
    assert.throws(
      () => execFileSync('node', [notifyScript, '--dispatch'], { stdio: 'pipe', env }),
      err => err.status === 1 && err.stderr.toString().includes('unsupported'),
    );
    assert.deepStrictEqual(snapshot(cachePath), before);

    // --test stays a manual notify-send test: prints a payload, exits 0, writes no cache.
    // PATH is emptied so no real desktop notification is sent; sent must be false.
    const testOut = JSON.parse(execFileSync(process.execPath, [notifyScript, '--test', STATUS.BURN], {
      encoding: 'utf8', env: { ...env, PATH: '' },
    }));
    assert.strictEqual(testOut.ok, true);
    assert.strictEqual(testOut.test, true);
    assert.strictEqual(testOut.sent, false);
    assert.strictEqual(testOut.payload.urgency, 'critical');
    assert.deepStrictEqual(snapshot(cachePath), before);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function run() {
  testFilesystemNotificationFlow();
  testCliInspectionIsReadOnly();
  testCliInspectionWithoutCacheDoesNotCreateIt();
  testCliProcessIsReadOnlyAndDispatchTest();
  testCliProcessExecution();
  console.log('All LetItCook notification integration tests passed.');
}

run();
