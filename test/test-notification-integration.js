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

    // 6b. Subsequent genuine completion after resuming cooking produces new notification
    writeSessionFile({
      session_id: 'sess-2',
      agent: 'copilot',
      status: STATUS.COOKING,
      updated_at: Date.now() + 10,
    }, sessionDir);
    sessions = readAllSessionsFromDir(sessionDir);
    const resumeEvents = doneTracker.processSessions(sessions);
    assert.strictEqual(resumeEvents.length, 0, 'Resumed cooking must not notify');

    writeSessionFile({
      session_id: 'sess-2',
      agent: 'copilot',
      status: STATUS.DONE,
      title: 'Tests passed again',
      updated_at: Date.now() + 20,
    }, sessionDir);
    sessions = readAllSessionsFromDir(sessionDir);
    const secondDoneEvents = doneTracker.processSessions(sessions);
    assert.strictEqual(secondDoneEvents.length, 1, 'Subsequent genuine completion must notify');
    assert.strictEqual(secondDoneEvents[0].reason, 'done');

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

function testRunNotifyCannotConsumePendingNotification() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-run-notify-ro-'));
  const sessionDir = path.join(tmpDir, 'sessions');
  const cachePath = path.join(tmpDir, 'state', 'letitcook', 'notify_cache.json');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  try {
    fs.writeFileSync(cachePath, JSON.stringify({
      _config: { notifyDone: true },
      sessions: { pending: { lastStatus: STATUS.COOKING, notifiedStatus: null } },
    }));
    fs.chmodSync(path.dirname(cachePath), 0o755);
    fs.chmodSync(cachePath, 0o644);
    writeSessionFile({
      session_id: 'pending', agent: 'opencode', status: STATUS.BURN,
      reason: 'test failure', updated_at: Date.now(),
    }, sessionDir);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(cachePath, old, old);
    const before = {
      content: fs.readFileSync(cachePath, 'utf8'),
      fileMode: fs.statSync(cachePath).mode & 0o777,
      dirMode: fs.statSync(path.dirname(cachePath)).mode & 0o777,
      mtime: fs.statSync(cachePath).mtimeMs,
    };

    const first = runNotify({ sessionDir, cachePath });
    const second = runNotify({ sessionDir, cachePath });
    assert.strictEqual(first.eventsCount, 1);
    assert.strictEqual(second.eventsCount, 1, 'repeated inspection must not consume pending event');
    assert.strictEqual(first.notifyDone, true);
    assert.deepStrictEqual({
      content: fs.readFileSync(cachePath, 'utf8'),
      fileMode: fs.statSync(cachePath).mode & 0o777,
      dirMode: fs.statSync(path.dirname(cachePath)).mode & 0o777,
      mtime: fs.statSync(cachePath).mtimeMs,
    }, before);

    // --watch reuses a read-only tracker, deduplicating in memory only.
    const watchTracker = new NotificationTracker({ cachePath, suppressInitial: false, readOnly: true });
    assert.strictEqual(runNotify({ sessionDir, cachePath, tracker: watchTracker }).eventsCount, 1);
    assert.strictEqual(runNotify({ sessionDir, cachePath, tracker: watchTracker }).eventsCount, 0);
    assert.deepStrictEqual({
      content: fs.readFileSync(cachePath, 'utf8'),
      fileMode: fs.statSync(cachePath).mode & 0o777,
      dirMode: fs.statSync(path.dirname(cachePath)).mode & 0o777,
      mtime: fs.statSync(cachePath).mtimeMs,
    }, before, 'watch deduplication stays in memory');

    const extensionTracker = new NotificationTracker({ cachePath, suppressInitial: false });
    assert.strictEqual(extensionTracker.processSessions(readAllSessionsFromDir(sessionDir)).length, 1,
      'the extension writer can still process the pending notification');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testCliProcessExecution() {
  const notifyScript = path.resolve('src/notify.js');
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-notify-cli-'));
  const env = {
    ...process.env,
    HOME: isolated,
    XDG_STATE_HOME: path.join(isolated, 'state'),
    XDG_DATA_HOME: path.join(isolated, 'data'),
  };

  try {
  const cachePath = path.join(env.XDG_STATE_HOME, 'letitcook', 'notify_cache.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ _config: { notifyDone: true }, sessions: {} }));
  fs.chmodSync(path.dirname(cachePath), 0o755);
  fs.chmodSync(cachePath, 0o644);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(cachePath, old, old);
  const before = {
    content: fs.readFileSync(cachePath, 'utf8'),
    mode: fs.statSync(cachePath).mode & 0o777,
    dirMode: fs.statSync(path.dirname(cachePath)).mode & 0o777,
    mtime: fs.statSync(cachePath).mtimeMs,
  };

  // Default one-shot runs cleanly with exit 0 and outputs JSON without cache mutations.
  const stdout = execFileSync('node', [notifyScript], { encoding: 'utf8', env });
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.owner, 'gnome-extension');
  assert.deepStrictEqual({
    content: fs.readFileSync(cachePath, 'utf8'),
    mode: fs.statSync(cachePath).mode & 0o777,
    dirMode: fs.statSync(path.dirname(cachePath)).mode & 0o777,
    mtime: fs.statSync(cachePath).mtimeMs,
  }, before, 'CLI process inspection must not alter cache contents, permissions, or mtime');

  // --include-done is an inspection-only override and is also read-only.
  execFileSync('node', [notifyScript, '--include-done'], { encoding: 'utf8', env });
  assert.deepStrictEqual({
    content: fs.readFileSync(cachePath, 'utf8'),
    mode: fs.statSync(cachePath).mode & 0o777,
    dirMode: fs.statSync(path.dirname(cachePath)).mode & 0o777,
    mtime: fs.statSync(cachePath).mtimeMs,
  }, before);

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

  fs.unlinkSync(cachePath);
  execFileSync('node', [notifyScript], { encoding: 'utf8', env });
  assert.strictEqual(fs.existsSync(cachePath), false, 'inspection must not create a missing cache');
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true });
  }
}

function testTerminatedSessionNotificationEvaluationAndCleanup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-term-int-'));
  const sessionDir = path.join(tmpDir, 'sessions');
  const cachePath = path.join(tmpDir, 'notify_cache.json');
  fs.mkdirSync(sessionDir, { recursive: true });

  const deadPid = 99999999;

  try {
    const tracker = new NotificationTracker({
      cachePath,
      notifyDone: true,
      suppressInitial: false,
    });

    // 1. Session begins Cooking
    writeSessionFile({
      session_id: 'term-sess-1',
      agent: 'opencode',
      status: STATUS.COOKING,
      title: 'Run migrations',
      pid: deadPid,
      updated_at: Date.now(),
    }, sessionDir);

    let sessions = readAllSessionsFromDir(sessionDir);
    tracker.processSessions(sessions);

    // 2. Session finishes Done, and process exits (PID becomes dead)
    writeSessionFile({
      session_id: 'term-sess-1',
      agent: 'opencode',
      status: STATUS.DONE,
      title: 'Run migrations',
      pid: deadPid,
      updated_at: Date.now(),
    }, sessionDir);

    // Simulate extension lifecycle scan:
    // Read sessions with dead PID detection: Done with dead PID is flagged terminated
    const isPidAlive = (pid) => pid !== deadPid;
    const scannedSessions = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => {
        const fullPath = path.join(sessionDir, f);
        const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const hasPid = typeof raw.pid === 'number';
        const alive = hasPid ? isPidAlive(raw.pid) : true;
        let terminated = false;
        if (hasPid && !alive) {
          if (raw.status === STATUS.DONE || raw.status === STATUS.BURN) {
            terminated = true;
          }
        }
        return {
          ...raw,
          filePath: fullPath,
          terminated,
        };
      });

    assert.strictEqual(scannedSessions.length, 1);
    assert.strictEqual(scannedSessions[0].terminated, true);

    // Evaluate notification BEFORE file deletion
    const events = tracker.processSessions(scannedSessions);
    assert.strictEqual(events.length, 1, 'Terminated Done session must be evaluated and emit notification before deletion');
    assert.strictEqual(events[0].session.session_id, 'term-sess-1');
    assert.strictEqual(events[0].reason, 'done');

    // Clean up terminated session files after evaluation
    for (const s of scannedSessions) {
      if (s.terminated && s.filePath) {
        fs.unlinkSync(s.filePath);
      }
    }

    // File must now be removed from disk
    assert.strictEqual(fs.existsSync(path.join(sessionDir, 'term-sess-1.json')), false, 'Terminated session file must be cleaned up');

    // Next scan: file is gone, so 0 duplicate notifications
    const nextSessions = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => JSON.parse(fs.readFileSync(path.join(sessionDir, f), 'utf8')));
    const nextEvents = tracker.processSessions(nextSessions);
    assert.strictEqual(nextEvents.length, 0, 'No duplicate notifications on subsequent scan after file cleanup');

    // 3. Repeat for Burn with dead PID: Cooking -> Burn -> notify -> clean up
    writeSessionFile({
      session_id: 'term-sess-2',
      agent: 'opencode',
      status: STATUS.COOKING,
      pid: deadPid,
      updated_at: Date.now(),
    }, sessionDir);
    let s2List = [{ session_id: 'term-sess-2', agent: 'opencode', status: STATUS.COOKING, pid: deadPid }];
    tracker.processSessions(s2List);

    writeSessionFile({
      session_id: 'term-sess-2',
      agent: 'opencode',
      status: STATUS.BURN,
      reason: 'Syntax error',
      pid: deadPid,
      updated_at: Date.now(),
    }, sessionDir);

    const burnScanned = [{
      session_id: 'term-sess-2',
      agent: 'opencode',
      status: STATUS.BURN,
      reason: 'Syntax error',
      pid: deadPid,
      filePath: path.join(sessionDir, 'term-sess-2.json'),
      terminated: true,
    }];

    const burnEvents = tracker.processSessions(burnScanned);
    assert.strictEqual(burnEvents.length, 1, 'Terminated Burn session must emit notification before deletion');
    assert.strictEqual(burnEvents[0].reason, 'burn');

    for (const s of burnScanned) {
      if (s.terminated && s.filePath) {
        fs.unlinkSync(s.filePath);
      }
    }
    assert.strictEqual(fs.existsSync(path.join(sessionDir, 'term-sess-2.json')), false);

    // 4. Cooking crash (PID dies during Cooking): must NOT infer Done or Burn
    writeSessionFile({
      session_id: 'term-sess-3',
      agent: 'opencode',
      status: STATUS.COOKING,
      pid: deadPid,
      updated_at: Date.now(),
    }, sessionDir);

    const crashedScanned = [{
      session_id: 'term-sess-3',
      agent: 'opencode',
      status: STATUS.UNKNOWN, // Crash maps to Unknown
      stale: true,
      pid: deadPid,
      filePath: path.join(sessionDir, 'term-sess-3.json'),
      terminated: false, // Not cleanly terminated
    }];

    const crashEvents = tracker.processSessions(crashedScanned);
    assert.strictEqual(crashEvents.length, 0, 'Process crash during cooking must never infer Done or Burn or notify');
    assert.ok(fs.existsSync(path.join(sessionDir, 'term-sess-3.json')), 'Crashed session file must remain visible as unknown');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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

    // Regression: real notify-send only accepts low|normal|critical and exits 1 on the
    // Your Turn payload urgency 'high', so `--test` (default: your_turn) reported sent:false.
    // A fake notify-send with the same validation records what the CLI passes.
    const fakeBin = path.join(tmpDir, 'fakebin');
    const argsLog = path.join(tmpDir, 'notify-send.args');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'notify-send'), [
      '#!/bin/sh',
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "-u" ]; then case "$a" in low|normal|critical) ;; *) exit 1 ;; esac; fi',
      '  prev="$a"',
      'done',
      `printf '%s\\n' "$*" >> '${argsLog}'`,
      '',
    ].join('\n'), { mode: 0o755 });
    for (const [args, urgency] of [[['--test'], 'normal'], [['--test', STATUS.YOUR_TURN], 'normal'], [['--test', STATUS.BURN], 'critical'], [['--test', STATUS.DONE], 'normal']]) {
      const out = JSON.parse(execFileSync(process.execPath, [notifyScript, ...args], {
        encoding: 'utf8', env: { ...env, PATH: fakeBin },
      }));
      assert.strictEqual(out.sent, true, `${args.join(' ')}: notify-send accepted the urgency`);
      const lastCall = fs.readFileSync(argsLog, 'utf8').trim().split('\n').pop();
      assert.ok(lastCall.endsWith(`-u ${urgency}`), `${args.join(' ')}: passes -u ${urgency} (got: ${lastCall})`);
    }
    assert.deepStrictEqual(snapshot(cachePath), before, 'manual tests never touch the cache');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function run() {
  testFilesystemNotificationFlow();
  testCliInspectionIsReadOnly();
  testCliInspectionWithoutCacheDoesNotCreateIt();
  testCliProcessIsReadOnlyAndDispatchTest();
  testRunNotifyCannotConsumePendingNotification();
  testCliProcessExecution();
  testTerminatedSessionNotificationEvaluationAndCleanup();
  console.log('All LetItCook notification integration tests passed.');
}

run();
