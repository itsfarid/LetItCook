import fs from 'node:fs';
import path from 'node:path';
import { BaseAdapter } from './base.js';
import { getSessionDir, readAllSessionsFromDir } from './opencode/adapter.js';
import { isValidSessionId } from '../core/fs-safe.js';
import { normalizeSession } from '../core/status.js';
import { readStateFile, stateFileName } from '../hooks/bridge.js';

// Registry adapter for agents that report through hooks: the agent runs
// `node src/hooks/hook.js <id>` per event (src/hooks/bridge.js), which writes
// `<id>_<session>.json` into the shared state directory. This class only detects the
// installation and reads those files; the event mapping lives in the agent's
// `hooks.js` (a pure `toSignals(input)`).
export class HookAdapter extends BaseAdapter {
  constructor({ id, name, bins = [], binEnv = null }) {
    super(id, name);
    this.bins = bins;
    this.binEnv = binEnv;
  }

  isAvailable() {
    if (this.binEnv && process.env[this.binEnv]) return true;
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      for (const bin of this.bins) {
        try {
          if (fs.statSync(path.join(dir, bin)).isFile()) return true;
        } catch {}
      }
    }
    return false;
  }

  detectSessions(options = {}) {
    const dir = options.baseDir || getSessionDir();
    return readAllSessionsFromDir(dir, options).filter(s => s.agent === this.id);
  }

  getSessionState(sessionId, options = {}) {
    if (!isValidSessionId(sessionId)) return null;
    const dir = options.baseDir || getSessionDir();
    const raw = readStateFile(path.join(dir, stateFileName(this.id, sessionId)), { sessionId, agent: this.id });
    return raw ? normalizeSession(raw, options) : null;
  }
}

export default HookAdapter;
