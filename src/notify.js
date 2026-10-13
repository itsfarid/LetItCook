import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { getSessionDir, readAllSessionsFromDir } from './adapters/opencode/adapter.js';
import {
  NotificationTracker,
  formatNotification,
  shouldNotify,
} from './core/notification.js';
import { STATUS } from './core/status.js';

export function sendDesktopNotification(title, body, urgency = 'normal') {
  try {
    execFileSync('notify-send', [title, body, '-u', urgency], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getCachePath() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'letitcook', 'notify_cache.json');
}

export function runNotify(options = {}) {
  if (options.dispatch === true) {
    return {
      ok: false,
      error: 'CLI dispatch unsupported: GNOME Shell extension is sole owner of automatic desktop notifications',
      owner: 'gnome-extension',
    };
  }

  const sessionDir = options.sessionDir || getSessionDir();
  const cachePath = options.cachePath || getCachePath();
  const notifyDone = options.notifyDone === true;

  const tracker = new NotificationTracker({
    cachePath,
    notifyDone,
    suppressInitial: options.suppressInitial !== false,
  });

  const sessions = readAllSessionsFromDir(sessionDir);
  const events = tracker.processSessions(sessions);

  return {
    ok: true,
    owner: 'gnome-extension',
    sessionDir,
    cachePath,
    notifyDone,
    sessionsCount: sessions.length,
    eventsCount: events.length,
    dispatched: false,
    events: events.map(e => ({
      session_id: e.session.session_id,
      agent: e.session.agent,
      status: e.session.status,
      title: e.title,
      body: e.body,
      urgency: e.urgency,
    })),
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectRun) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`LetItCook Notification Tool (inspection & manual test utility)
Note: GNOME Shell extension is the sole owner of automatic desktop notifications.

Usage:
  node src/notify.js                 Inspect notification state (one-shot, non-competing)
  node src/notify.js --include-done  Include Done status transitions in inspection
  node src/notify.js --test [status] Fire a manual test notification via notify-send
  node src/notify.js --watch [ms]    Optional inspection loop (prints transitions to stdout)

CLI automatic dispatch is unsupported to prevent duplicate alerts and race conditions.
`);
    process.exit(0);
  }

  if (args.includes('--dispatch')) {
    console.error('[letitcook-notify] Error: CLI automatic dispatch is unsupported. GNOME Shell extension is the sole owner of automatic desktop notifications to prevent duplicate alerts.');
    process.exit(1);
  }

  if (args.includes('--test')) {
    const idx = args.indexOf('--test');
    const targetStatus = args[idx + 1] || STATUS.YOUR_TURN;
    const mock = {
      session_id: 'test-session',
      agent: 'test-agent',
      status: targetStatus,
      title: 'Testing notifications',
      reason: 'manual verification',
    };
    const payload = formatNotification(mock);
    const sent = sendDesktopNotification(payload.title, payload.body, payload.urgency);
    console.log(JSON.stringify({ ok: true, test: true, sent, payload }));
    process.exit(0);
  }

  const notifyDone = args.includes('--include-done');

  if (args.includes('--watch')) {
    const idx = args.indexOf('--watch');
    const intervalMs = Math.max(1000, parseInt(args[idx + 1] || '5000', 10) || 5000);
    console.error(`[letitcook-notify] Watching every ${intervalMs}ms (GNOME extension is primary owner)`);
    const tick = () => {
      try {
        const result = runNotify({ notifyDone, suppressInitial: false });
        if (result.eventsCount > 0) {
          console.log(JSON.stringify(result));
        }
      } catch (e) {
        console.error(`[letitcook-notify] ${e?.message || e}`);
      }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    const stop = () => { clearInterval(timer); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } else {
    const result = runNotify({ notifyDone });
    console.log(JSON.stringify(result, null, 2));
  }
}
