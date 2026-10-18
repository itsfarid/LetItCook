import {
  mapOpenCodeEvent,
  mapToolHook,
  writeSessionFile,
  deleteSessionFile,
  hasMeaningfulStateChange,
  isHeartbeatDue,
  extractSessionId,
} from './adapter.js';

const activeSessions = new Map();

export const LetItCookPlugin = async (ctx) => {

  return {
    event: async ({ event }) => {
      if (!event || typeof event.type !== 'string' || !event.type) return;

      const sid = extractSessionId(event);
      if (!sid || sid === 'global') return;

      const prev = activeSessions.get(sid) || null;
      const mapped = mapOpenCodeEvent(event, prev);
      if (!mapped) return;

      if (mapped.deleted) {
        activeSessions.delete(sid);
        deleteSessionFile(sid);
        return;
      }

      if (!hasMeaningfulStateChange(prev, mapped) && !isHeartbeatDue(prev, mapped)) {
        return;
      }

      activeSessions.set(sid, mapped);
      try {
        writeSessionFile(mapped);
      } catch {}
    },
    'tool.execute.before': async (input) => {
      const sid = (input && (input.sessionID || input.sessionId)) || null;
      if (!sid || sid === 'global') return;
      const prev = activeSessions.get(sid) || null;
      const mapped = mapToolHook('before', input, prev);
      if (!mapped || (!hasMeaningfulStateChange(prev, mapped) && !isHeartbeatDue(prev, mapped))) {
        return;
      }
      activeSessions.set(sid, mapped);
      try {
        writeSessionFile(mapped);
      } catch {}
    },
    'tool.execute.after': async (input) => {
      const sid = (input && (input.sessionID || input.sessionId)) || null;
      if (!sid || sid === 'global') return;
      const prev = activeSessions.get(sid) || null;
      const mapped = mapToolHook('after', input, prev);
      if (!mapped || (!hasMeaningfulStateChange(prev, mapped) && !isHeartbeatDue(prev, mapped))) {
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
