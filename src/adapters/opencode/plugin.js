import {
  mapOpenCodeEvent,
  mapToolHook,
  writeSessionFile,
  deleteSessionFile,
  hasMeaningfulStateChange,
} from './adapter.js';
import { STATUS } from '../../core/status.js';

const activeSessions = new Map();
let exitHookRegistered = false;

function registerExitHook() {
  if (exitHookRegistered) return;
  if (typeof process !== 'undefined' && process.on) {
    process.on('exit', () => {
      for (const [sid, mapped] of activeSessions.entries()) {
        if (mapped.status === STATUS.DONE || mapped.status === STATUS.BURN) {
          deleteSessionFile(sid);
        }
      }
    });
    exitHookRegistered = true;
  }
}

export const LetItCookPlugin = async (ctx) => {
  registerExitHook();

  return {
    event: async ({ event }) => {
      if (!event || !event.type) return;

      const sid = (event.properties && (event.properties.sessionID || event.properties.sessionId)) ||
                  (event.properties?.session?.id) ||
                  (event.properties?.info?.id) || 'global';

      const prev = activeSessions.get(sid) || null;
      const mapped = mapOpenCodeEvent(event, prev);
      if (!mapped) return;

      if (mapped.deleted) {
        activeSessions.delete(sid);
        deleteSessionFile(sid);
        return;
      }

      if (!hasMeaningfulStateChange(prev, mapped)) {
        return;
      }

      activeSessions.set(sid, mapped);
      try {
        writeSessionFile(mapped);
      } catch {}
    },
    'tool.execute.before': async (input) => {
      const sid = (input && (input.sessionID || input.sessionId)) || 'global';
      const prev = activeSessions.get(sid) || null;
      const mapped = mapToolHook('before', input, prev);
      if (!hasMeaningfulStateChange(prev, mapped)) {
        return;
      }
      activeSessions.set(sid, mapped);
      try {
        writeSessionFile(mapped);
      } catch {}
    },
    'tool.execute.after': async (input) => {
      const sid = (input && (input.sessionID || input.sessionId)) || 'global';
      const prev = activeSessions.get(sid) || null;
      const mapped = mapToolHook('after', input, prev);
      if (!hasMeaningfulStateChange(prev, mapped)) {
        return;
      }
      activeSessions.set(sid, mapped);
      try {
        writeSessionFile(mapped);
      } catch {}
    },
  };
};

export default LetItCookPlugin;
