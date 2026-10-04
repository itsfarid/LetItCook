import {
  mapOpenCodeEvent,
  mapToolHook,
  writeSessionFile,
  deleteSessionFile,
  hasMeaningfulStateChange,
} from './adapter.js';

const activeSessions = new Map();

export const LetItCookPlugin = async (ctx) => {
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
