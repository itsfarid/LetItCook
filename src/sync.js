// LetItCook sync bridge: poll-based adapters (e.g. Copilot CLI) do not push
// state into the shared LetItCook state dir on their own, so this tiny CLI
// copies their normalized sessions there where the GNOME extension reads them.
//
// Usage:
//   node src/sync.js                 one-shot sync, then exit
//   node src/sync.js --watch [ms]    repeat every `ms` (default 5000)
//
// Env:
//   LETITCOOK_STATE_DIR   target dir (default ~/.local/state/letitcook/sessions)
//   LETITCOOK_COPILOT_DIR copilot home override (default ~/.copilot)

import path from 'node:path';
import os from 'node:os';
import { defaultRegistry } from './core/registry.js';
import { getSessionDir } from './adapters/opencode/adapter.js';
import { ensurePrivateDir } from './core/fs-safe.js';

function syncOnce(targetDir) {
  const synced = defaultRegistry.syncAll(targetDir);
  const available = defaultRegistry.getAvailable().map(a => a.id);
  console.log(JSON.stringify({
    ok: true,
    targetDir,
    availableAdapters: available,
    syncedSessions: synced.map(s => ({ agent: s.agent, session_id: s.session_id, status: s.status })),
  }));
  return synced;
}

const args = process.argv.slice(2);
const targetDir = getSessionDir();

if (args[0] === '--watch') {
  const intervalMs = Math.max(1000, parseInt(args[1] || '5000', 10) || 5000);
  ensurePrivateDir(targetDir);
  const tick = () => {
    try {
      syncOnce(targetDir);
    } catch (e) {
      console.error(`[letitcook-sync] ${e && e.message ? e.message : e}`);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.error(`[letitcook-sync] watching every ${intervalMs}ms -> ${targetDir}`);
} else if (args[0] === '--help' || args[0] === '-h') {
  console.log('Usage: node src/sync.js [--watch [ms]]');
} else {
  ensurePrivateDir(targetDir);
  syncOnce(targetDir);
}

export default { syncOnce };
