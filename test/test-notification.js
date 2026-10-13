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

function run() {
  testShortCwd();
  testSanitizeText();
  testShouldNotify();
  testFormatNotification();
  testNotificationTrackerLifecycle();
  testAtomicCacheSaveAndCleanup();
  console.log('All LetItCook notification unit tests passed.');
}

run();
