import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATUS } from '../src/core/status.js';
import {
  sanitizeText,
  shortCwd,
  shouldNotify,
  formatNotification,
  NotificationTracker,
} from '../src/core/notification.js';

function testShortCwd() {
  assert.strictEqual(shortCwd(''), 'global');
  assert.strictEqual(shortCwd(null), 'global');
  assert.strictEqual(shortCwd(undefined), 'global');
  assert.strictEqual(shortCwd('/one/two/three/four'), 'three/four');

  const home = os.homedir();
  assert.strictEqual(shortCwd(path.join(home, 'projects', 'myapp')), 'projects/myapp');
}

function testSanitizeText() {
  assert.strictEqual(sanitizeText('Hello World'), 'Hello World');
  assert.strictEqual(sanitizeText('\u001b[31mRed Text\u001b[0m'), 'Red Text');
  assert.strictEqual(sanitizeText('Line 1\nLine 2\r\tLine 3'), 'Line 1 Line 2 Line 3');
  assert.strictEqual(sanitizeText('A'.repeat(200), 50).length, 50);
  assert.strictEqual(sanitizeText(null), '');
  assert.strictEqual(sanitizeText(undefined), '');
  assert.strictEqual(sanitizeText(123), '');
}

function testShouldNotify() {
  // 1. Normal notify-worthy transitions
  const yourTurnSession = { status: STATUS.YOUR_TURN, agent: 'opencode', session_id: 's1' };
  assert.deepStrictEqual(shouldNotify(STATUS.COOKING, yourTurnSession), {
    notify: true,
    reason: 'your_turn',
    priority: 'high',
  });

  const burnSession = { status: STATUS.BURN, agent: 'opencode', session_id: 's2' };
  assert.deepStrictEqual(shouldNotify(STATUS.COOKING, burnSession), {
    notify: true,
    reason: 'burn',
    priority: 'critical',
  });

  // 2. Suppressed statuses: Cooking and Unknown must NEVER notify
  const cookingSession = { status: STATUS.COOKING, agent: 'opencode', session_id: 's3' };
  assert.deepStrictEqual(shouldNotify(null, cookingSession), {
    notify: false,
    reason: 'suppressed_status',
  });
  assert.deepStrictEqual(shouldNotify(STATUS.YOUR_TURN, cookingSession), {
    notify: false,
    reason: 'suppressed_status',
  });

  const unknownSession = { status: STATUS.UNKNOWN, agent: 'opencode', session_id: 's4' };
  assert.deepStrictEqual(shouldNotify(STATUS.COOKING, unknownSession), {
    notify: false,
    reason: 'suppressed_status',
  });

  // 3. Stale and low-confidence sessions must NEVER notify
  const staleSession = { status: STATUS.YOUR_TURN, stale: true, session_id: 's5' };
  assert.deepStrictEqual(shouldNotify(STATUS.COOKING, staleSession), {
    notify: false,
    reason: 'stale_session',
  });

  const lowConfidenceSession = { status: STATUS.YOUR_TURN, confidence: 'low', session_id: 's6' };
  assert.deepStrictEqual(shouldNotify(STATUS.COOKING, lowConfidenceSession), {
    notify: false,
    reason: 'low_confidence',
  });

  // 4. Same status (no transition) must NEVER notify
  assert.deepStrictEqual(shouldNotify(STATUS.YOUR_TURN, yourTurnSession), {
    notify: false,
    reason: 'no_status_change',
  });

  // 5. Done transition: opt-in and trustworthy check
  const doneSession = { status: STATUS.DONE, session_id: 's7' };
  // Default: notifyDone = false
  assert.deepStrictEqual(shouldNotify(STATUS.COOKING, doneSession, { notifyDone: false }), {
    notify: false,
    reason: 'done_opted_out',
  });
  // Opt-in: notifyDone = true from Cooking
  assert.deepStrictEqual(shouldNotify(STATUS.COOKING, doneSession, { notifyDone: true }), {
    notify: true,
    reason: 'done',
    priority: 'normal',
  });
  // Opt-in but untrustworthy: Done from null or Unknown
  assert.deepStrictEqual(shouldNotify(null, doneSession, { notifyDone: true }), {
    notify: false,
    reason: 'untrustworthy_done',
  });
  assert.deepStrictEqual(shouldNotify(STATUS.UNKNOWN, doneSession, { notifyDone: true }), {
    notify: false,
    reason: 'untrustworthy_done',
  });

  // 6. Invalid session data
  assert.deepStrictEqual(shouldNotify(STATUS.COOKING, null), {
    notify: false,
    reason: 'invalid_session',
  });
}

function testFormatNotification() {
  const yt = formatNotification({
    agent: 'copilot',
    status: STATUS.YOUR_TURN,
    title: 'Review edits',
    reason: 'permission needed',
  });
  assert.strictEqual(yt.title, 'LetItCook: copilot');
  assert.strictEqual(yt.body, 'Your Turn (permission needed) • Review edits');
  assert.strictEqual(yt.urgency, 'high');

  const burn = formatNotification({
    agent: 'opencode',
    status: STATUS.BURN,
    reason: 'rate limit reached',
    cwd: '/tmp/repo',
  });
  assert.strictEqual(burn.title, 'LetItCook: opencode');
  assert.strictEqual(burn.body, 'Burn: rate limit reached • /tmp/repo');
  assert.strictEqual(burn.urgency, 'critical');

  const done = formatNotification({
    agent: 'opencode',
    status: STATUS.DONE,
    title: 'All tests pass',
  });
  assert.strictEqual(done.title, 'LetItCook: opencode');
  assert.strictEqual(done.body, 'Done • All tests pass');
  assert.strictEqual(done.urgency, 'normal');
}

function testNotificationTrackerLifecycle() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-notify-unit-'));
  const cachePath = path.join(tmpDir, 'cache.json');

  try {
    const tracker = new NotificationTracker({
      cachePath,
      notifyDone: false,
      suppressInitial: true,
    });

    // 1. Cold start / initial scan suppresses pre-existing sessions
    const initialSessions = [
      { session_id: 's1', agent: 'opencode', status: STATUS.YOUR_TURN },
      { session_id: 's2', agent: 'copilot', status: STATUS.COOKING },
    ];
    const initialEvents = tracker.processSessions(initialSessions);
    assert.strictEqual(initialEvents.length, 0, 'Cold start must not fire notifications');

    // 2. No transition on re-scan
    const secondScanEvents = tracker.processSessions(initialSessions);
    assert.strictEqual(secondScanEvents.length, 0, 'Identical state must not fire notifications');

    // 3. Legitimate transition: s2 transitions from cooking to your_turn
    const updatedSessions = [
      { session_id: 's1', agent: 'opencode', status: STATUS.YOUR_TURN },
      { session_id: 's2', agent: 'copilot', status: STATUS.YOUR_TURN, reason: 'terminal prompt' },
    ];
    const transitionEvents = tracker.processSessions(updatedSessions);
    assert.strictEqual(transitionEvents.length, 1, 'Transition to your_turn must notify once');
    assert.strictEqual(transitionEvents[0].session.session_id, 's2');
    assert.strictEqual(transitionEvents[0].urgency, 'high');

    // 4. Repeated writes/polling with same state produces 0 duplicate notifications
    for (let i = 0; i < 5; i++) {
      const dupeEvents = tracker.processSessions(updatedSessions);
      assert.strictEqual(dupeEvents.length, 0, 'Repeated polling must produce 0 duplicate notifications');
    }

    // 5. Agent resumes cooking, then requests input again
    const resumedSessions = [
      { session_id: 's1', agent: 'opencode', status: STATUS.YOUR_TURN },
      { session_id: 's2', agent: 'copilot', status: STATUS.COOKING },
    ];
    const cookingEvents = tracker.processSessions(resumedSessions);
    assert.strictEqual(cookingEvents.length, 0, 'Return to cooking must produce 0 notifications');

    const secondYourTurn = [
      { session_id: 's1', agent: 'opencode', status: STATUS.YOUR_TURN },
      { session_id: 's2', agent: 'copilot', status: STATUS.YOUR_TURN, reason: 'second prompt' },
    ];
    const secondYtEvents = tracker.processSessions(secondYourTurn);
    assert.strictEqual(secondYtEvents.length, 1, 'Subsequent transition to your_turn after cooking must notify');

    // 6. Persistence across restart
    const trackerRestart = new NotificationTracker({
      cachePath,
      notifyDone: false,
      suppressInitial: false,
    });
    const restartEvents = trackerRestart.processSessions(secondYourTurn);
    assert.strictEqual(restartEvents.length, 0, 'Restart with persisted cache must not re-notify existing state');

    // 7. Pruning removed session
    const singleSession = [{ session_id: 's2', agent: 'copilot', status: STATUS.YOUR_TURN }];
    trackerRestart.processSessions(singleSession);
    assert.strictEqual(trackerRestart._cache.sessions['s1'], undefined, 'Removed session must be pruned from cache');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testPrivateAtomicCachePersistence() {
  assert.ok(typeof fs.constants.O_NOFOLLOW === 'number' && fs.constants.O_NOFOLLOW !== 0,
    'secure cache access requires platform O_NOFOLLOW support');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-private-cache-'));
  const cacheDir = path.join(root, 'letitcook');
  const cachePath = path.join(cacheDir, 'notify_cache.json');
  const mode = p => fs.lstatSync(p).mode & 0o777;
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(cacheDir, 0o755);
    fs.writeFileSync(cachePath, '{"old":true}', { mode: 0o644 });
    fs.chmodSync(cachePath, 0o644);

    const tracker = new NotificationTracker({ cachePath, suppressInitial: false });
    tracker._cache.sessions.secure = { lastStatus: STATUS.COOKING };
    tracker.save();

    assert.strictEqual(mode(cacheDir), 0o700, 'cache directory must be private');
    assert.strictEqual(mode(cachePath), 0o600, 'replacement cache must be private');
    assert.strictEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')).sessions.secure.lastStatus, STATUS.COOKING);
    assert.deepStrictEqual(fs.readdirSync(cacheDir), ['notify_cache.json'], 'successful save leaves no temp file');

    // A failed rename leaves the old cache contents intact and removes our private temp.
    const oldContents = fs.readFileSync(cachePath, 'utf8');
    const originalRename = fs.renameSync;
    let observedTemp = false;
    fs.renameSync = (from, to) => {
      assert.strictEqual(path.dirname(from), cacheDir, 'temp must share target directory');
      assert.strictEqual(to, cachePath);
      assert.strictEqual(mode(from), 0o600, 'temp file must be owner-only before rename');
      observedTemp = true;
      throw new Error('injected rename failure');
    };
    try {
      tracker._cache.sessions.secure.lastStatus = STATUS.BURN;
      tracker.save();
    } finally {
      fs.renameSync = originalRename;
    }
    assert.ok(observedTemp, 'rename failure injection reached');
    assert.strictEqual(fs.readFileSync(cachePath, 'utf8'), oldContents, 'failed atomic replacement preserves old contents');
    assert.deepStrictEqual(fs.readdirSync(cacheDir), ['notify_cache.json'], 'failed save cleans up temp file');

    // A write failure also closes and removes the securely-created temp file.
    const originalWrite = fs.writeFileSync;
    let observedWriteTemp = false;
    fs.writeFileSync = (target, ...args) => {
      if (typeof target === 'number') {
        observedWriteTemp = true;
        throw new Error('injected write failure');
      }
      return originalWrite(target, ...args);
    };
    try {
      tracker.save();
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.ok(observedWriteTemp, 'write failure injection reached');
    assert.strictEqual(fs.readFileSync(cachePath, 'utf8'), oldContents, 'write failure preserves cache contents');
    assert.deepStrictEqual(fs.readdirSync(cacheDir), ['notify_cache.json'], 'write failure cleans up temp file');

    // A changed target detected before rename aborts and preserves the replacement.
    const originalLstat = fs.lstatSync;
    const racedContents = '{"unrelated":true}';
    const raceSource = path.join(cacheDir, 'race-source');
    originalWrite(raceSource, racedContents, 'utf8');
    let cacheTargetChecks = 0;
    fs.lstatSync = (target, ...args) => {
      if (target === cachePath && ++cacheTargetChecks === 2) {
        fs.unlinkSync(cachePath);
        fs.renameSync(raceSource, cachePath);
      }
      return originalLstat(target, ...args);
    };
    try {
      tracker.save();
    } finally {
      fs.lstatSync = originalLstat;
    }
    assert.strictEqual(fs.readFileSync(cachePath, 'utf8'), racedContents, 'changed target is not replaced');
    assert.deepStrictEqual(fs.readdirSync(cacheDir), ['notify_cache.json'], 'race abort cleans up temp file');
    fs.writeFileSync(cachePath, oldContents, 'utf8');
    fs.chmodSync(cachePath, 0o600);

    // Cache symlinks must never be chmod-ed, followed, or replaced by the Node writer.
    const victim = path.join(root, 'victim.json');
    fs.writeFileSync(victim, '{"sensitive":true}');
    fs.chmodSync(victim, 0o644);
    const victimBefore = { content: fs.readFileSync(victim, 'utf8'), mode: mode(victim), mtime: fs.statSync(victim).mtimeMs };
    fs.unlinkSync(cachePath);
    fs.symlinkSync(victim, cachePath);
    const symlinkTracker = new NotificationTracker({ cachePath, suppressInitial: false });
    symlinkTracker._cache.sessions.bad = { lastStatus: STATUS.BURN };
    symlinkTracker.save();
    assert.ok(fs.lstatSync(cachePath).isSymbolicLink(), 'existing symlink must remain untouched');
    assert.deepStrictEqual({ content: fs.readFileSync(victim, 'utf8'), mode: mode(victim), mtime: fs.statSync(victim).mtimeMs }, victimBefore);
    assert.deepStrictEqual(fs.readdirSync(cacheDir), ['notify_cache.json']);

    // Hard links are also rejected so chmod cannot alter an unrelated alias.
    fs.unlinkSync(cachePath);
    fs.linkSync(victim, cachePath);
    const linkedVictimBefore = { content: fs.readFileSync(victim, 'utf8'), mode: mode(victim) };
    const hardlinkTracker = new NotificationTracker({ cachePath, suppressInitial: false });
    hardlinkTracker.save();
    assert.strictEqual(fs.statSync(cachePath).ino, fs.statSync(victim).ino, 'hard link is not replaced');
    assert.deepStrictEqual({ content: fs.readFileSync(victim, 'utf8'), mode: mode(victim) }, linkedVictimBefore);

    // A symlink used as the cache directory is rejected without chmod or writes to its target.
    const unrelated = path.join(root, 'unrelated');
    fs.mkdirSync(unrelated);
    fs.chmodSync(unrelated, 0o755);
    const unrelatedMode = mode(unrelated);
    const linkedDir = path.join(root, 'linked-letitcook');
    fs.symlinkSync(unrelated, linkedDir);
    const linkedTracker = new NotificationTracker({ cachePath: path.join(linkedDir, 'notify_cache.json') });
    linkedTracker.save();
    assert.strictEqual(mode(unrelated), unrelatedMode, 'symlink target directory permissions stay unchanged');
    assert.deepStrictEqual(fs.readdirSync(unrelated), []);

    // Non-regular targets are refused rather than replaced.
    const nonRegularTarget = path.join(cacheDir, 'directory-target');
    fs.mkdirSync(nonRegularTarget);
    fs.chmodSync(nonRegularTarget, 0o755);
    const nonRegularTracker = new NotificationTracker({ cachePath: nonRegularTarget });
    nonRegularTracker.save();
    assert.ok(fs.lstatSync(nonRegularTarget).isDirectory());
    assert.strictEqual(mode(nonRegularTarget), 0o755);
    assert.deepStrictEqual(fs.readdirSync(nonRegularTarget), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testReadOnlyCachePersistence() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-readonly-cache-'));
  const dir = path.join(root, 'letitcook');
  const cachePath = path.join(dir, 'notify_cache.json');
  const mode = p => fs.lstatSync(p).mode & 0o777;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ _config: { notifyDone: true }, sessions: {} }));
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(cachePath, 0o644);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(cachePath, old, old);
    const before = { content: fs.readFileSync(cachePath, 'utf8'), mode: mode(cachePath), dirMode: mode(dir), mtime: fs.statSync(cachePath).mtimeMs };

    const tracker = new NotificationTracker({ cachePath, readOnly: true, suppressInitial: false });
    tracker.processSessions([{ session_id: 's', status: STATUS.BURN }]);
    tracker.save();
    const after = { content: fs.readFileSync(cachePath, 'utf8'), mode: mode(cachePath), dirMode: mode(dir), mtime: fs.statSync(cachePath).mtimeMs };
    assert.deepStrictEqual(after, before, 'read-only inspection cannot change contents, modes, or mtime');
    assert.strictEqual(tracker.notifyDone, true, 'read-only load preserves persisted preference');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testAtomicCacheSaveAndCleanup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-atomic-'));
  const cachePath = path.join(tmpDir, 'notify_cache.json');

  try {
    const tracker = new NotificationTracker({
      cachePath,
      notifyDone: false,
      suppressInitial: false,
    });
    tracker._cache.sessions['test'] = { lastStatus: 'cooking' };
    tracker.save();

    assert.ok(fs.existsSync(cachePath), 'Cache file must exist after save');
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.strictEqual(parsed.sessions.test.lastStatus, 'cooking');

    // Verify no temporary files left in directory
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter(f => f.startsWith('.notify_cache.tmp.'));
    assert.strictEqual(tmpFiles.length, 0, 'No temporary files should linger after successful atomic save');

    // Simulate failure when target directory is blocked by a plain file
    const blockedDir = path.join(tmpDir, 'blocked-file');
    fs.writeFileSync(blockedDir, 'blocking-content');
    const brokenTracker = new NotificationTracker({
      cachePath: path.join(blockedDir, 'cache.json'),
      notifyDone: false,
    });
    // save() must handle error gracefully without throwing
    brokenTracker.save();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testUnchangedCacheAvoidsDiskWrite() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-unchanged-cache-'));
  const cachePath = path.join(tmpDir, 'notify_cache.json');

  try {
    const tracker = new NotificationTracker({
      cachePath,
      notifyDone: true,
      suppressInitial: true,
    });

    const sessions = [
      { session_id: 's1', agent: 'opencode', status: STATUS.COOKING },
    ];

    // Initial scan with new session -> saves to disk
    const initialEvents = tracker.processSessions(sessions);
    assert.strictEqual(initialEvents.length, 0);
    assert.ok(fs.existsSync(cachePath), 'Cache file must be created on initial scan');

    const mtime1 = fs.statSync(cachePath).mtimeMs;
    const content1 = fs.readFileSync(cachePath, 'utf8');

    // Repeated scan with EXACT same session and status -> save() must return false (no write)
    const saved = tracker.save();
    assert.strictEqual(saved, false, 'Explicit save on unchanged cache must return false');

    const repeatEvents = tracker.processSessions(sessions);
    assert.strictEqual(repeatEvents.length, 0);
    const mtime2 = fs.statSync(cachePath).mtimeMs;
    const content2 = fs.readFileSync(cachePath, 'utf8');

    assert.strictEqual(mtime1, mtime2, 'File modification time must remain unchanged when cache is unchanged');
    assert.strictEqual(content1, content2, 'Cache content must remain identical');

    // State transition -> cache changes -> must save and update file
    const updatedSessions = [
      { session_id: 's1', agent: 'opencode', status: STATUS.YOUR_TURN, reason: 'prompt' },
    ];
    const updateEvents = tracker.processSessions(updatedSessions);
    assert.strictEqual(updateEvents.length, 1);
    const content3 = fs.readFileSync(cachePath, 'utf8');
    assert.notStrictEqual(content1, content3, 'Cache content must be updated after status transition');
    const parsed = JSON.parse(content3);
    assert.strictEqual(parsed.sessions.s1.lastStatus, STATUS.YOUR_TURN);
    assert.strictEqual(parsed.sessions.s1.notifiedStatus, STATUS.YOUR_TURN);

    // Re-scan with same status -> again no write
    const noWriteEvents = tracker.processSessions(updatedSessions);
    assert.strictEqual(noWriteEvents.length, 0);
    const savedAfter = tracker.save();
    assert.strictEqual(savedAfter, false, 'Unchanged cache after transition must not write');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testTerminalNotificationDeduplicationAndSuppression() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-terminal-test-'));
  const cachePath = path.join(tmpDir, 'notify_cache.json');

  try {
    // 1. Stale session with terminal status is suppressed
    assert.strictEqual(shouldNotify(STATUS.COOKING, { status: STATUS.DONE, stale: true }, { notifyDone: true }).notify, false);
    assert.strictEqual(shouldNotify(STATUS.COOKING, { status: STATUS.BURN, stale: true }).notify, false);

    // 2. Low confidence session with terminal status is suppressed
    assert.strictEqual(shouldNotify(STATUS.COOKING, { status: STATUS.DONE, confidence: 'low' }, { notifyDone: true }).notify, false);
    assert.strictEqual(shouldNotify(STATUS.COOKING, { status: STATUS.BURN, confidence: 'low' }).notify, false);

    // 3. Done without prior Cooking is suppressed
    assert.strictEqual(shouldNotify(STATUS.UNKNOWN, { status: STATUS.DONE }, { notifyDone: true }).notify, false);
    assert.strictEqual(shouldNotify(null, { status: STATUS.DONE }, { notifyDone: true }).notify, false);
    assert.strictEqual(shouldNotify(STATUS.YOUR_TURN, { status: STATUS.DONE }, { notifyDone: true }).notify, false);

    // 4. Done with notifyDone=false (default) is suppressed
    assert.strictEqual(shouldNotify(STATUS.COOKING, { status: STATUS.DONE }, { notifyDone: false }).notify, false);
    assert.strictEqual(shouldNotify(STATUS.COOKING, { status: STATUS.DONE }).notify, false);

    // 5. Eligible Done (Cooking -> Done, notifyDone=true) notifies exactly once
    const tracker = new NotificationTracker({
      cachePath,
      notifyDone: true,
      suppressInitial: false,
    });

    const cooking = [{ session_id: 'term-1', agent: 'opencode', status: STATUS.COOKING }];
    tracker.processSessions(cooking);

    const done = [{ session_id: 'term-1', agent: 'opencode', status: STATUS.DONE, title: 'Job complete' }];
    const events1 = tracker.processSessions(done);
    assert.strictEqual(events1.length, 1, 'Cooking -> Done transition must notify once');
    assert.strictEqual(events1[0].reason, 'done');

    const events2 = tracker.processSessions(done);
    assert.strictEqual(events2.length, 0, 'Subsequent scan with Done must not re-notify');

    // 6. Eligible Burn (Cooking -> Burn) notifies exactly once
    const burn = [{ session_id: 'term-2', agent: 'opencode', status: STATUS.BURN, reason: 'Segmentation fault' }];
    const burnEvents1 = tracker.processSessions(burn);
    assert.strictEqual(burnEvents1.length, 1, 'Burn transition must notify once');
    assert.strictEqual(burnEvents1[0].reason, 'burn');

    const burnEvents2 = tracker.processSessions(burn);
    assert.strictEqual(burnEvents2.length, 0, 'Subsequent scan with Burn must not re-notify');

    // 7. Cold start suppression for pre-existing Done and Burn
    const coldTracker = new NotificationTracker({
      cachePath: path.join(tmpDir, 'cold_cache.json'),
      notifyDone: true,
      suppressInitial: true,
    });
    const preExisting = [
      { session_id: 'pre-1', agent: 'opencode', status: STATUS.DONE },
      { session_id: 'pre-2', agent: 'opencode', status: STATUS.BURN },
    ];
    const coldEvents = coldTracker.processSessions(preExisting);
    assert.strictEqual(coldEvents.length, 0, 'Cold start must suppress pre-existing Done and Burn sessions');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testReadOnlyTracker() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-ro-unit-'));
  const cachePath = path.join(tmpDir, 'notify_cache.json');
  try {
    // readOnly never creates a cache and still reports events
    const ro = new NotificationTracker({ cachePath, suppressInitial: false, readOnly: true });
    ro.processSessions([{ session_id: 'a', status: STATUS.COOKING }]);
    const events = ro.processSessions([{ session_id: 'a', status: STATUS.BURN, agent: 'x' }]);
    assert.strictEqual(events.length, 1);
    ro.save();
    assert.strictEqual(fs.existsSync(cachePath), false, 'readOnly tracker must not write');

    // Writable tracker still persists (atomic write) with its config
    const rw = new NotificationTracker({ cachePath, notifyDone: true, suppressInitial: false });
    rw.processSessions([{ session_id: 'a', status: STATUS.COOKING }]);
    const persisted = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.strictEqual(persisted._config.notifyDone, true);
    assert.strictEqual(persisted.sessions.a.lastStatus, STATUS.COOKING);
    assert.deepStrictEqual(fs.readdirSync(tmpDir), ['notify_cache.json']);

    // readOnly with undefined notifyDone inherits persisted preference without altering it
    const before = fs.readFileSync(cachePath, 'utf8');
    const inherit = new NotificationTracker({ cachePath, readOnly: true, suppressInitial: false });
    assert.strictEqual(inherit.notifyDone, true);
    inherit.processSessions([{ session_id: 'a', status: STATUS.DONE }]);
    assert.strictEqual(fs.readFileSync(cachePath, 'utf8'), before);
 } finally {
   fs.rmSync(tmpDir, { recursive: true, force: true });
 }
}

function run() {
  testReadOnlyTracker();
  testShortCwd();
  testSanitizeText();
  testShouldNotify();
  testFormatNotification();
  testNotificationTrackerLifecycle();
  testPrivateAtomicCachePersistence();
  testReadOnlyCachePersistence();
  testAtomicCacheSaveAndCleanup();
  testUnchangedCacheAvoidsDiskWrite();
  testTerminalNotificationDeduplicationAndSuppression();
  console.log('All LetItCook notification unit tests passed.');
}

run();
