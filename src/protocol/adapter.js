// Generic adapter for the LetItCook event protocol (docs/protocol.md).
//
// - `protocolHooks` is the hook-bridge adapter behind `node src/hooks/hook.js event`: it
//   validates the event (16 KiB limit), routes it to `@<agent>.<session>.json` and maps
//   it to lifecycle signals. All state rules, locking and file safety are the shared
//   ones (src/core/lifecycle.js, src/hooks/bridge.js); nothing here is agent-specific.
// - `ProtocolAdapter` is the registry adapter listing protocol sessions.

import path from 'node:path';
import { BaseAdapter } from '../adapters/base.js';
import { getSessionDir, readAllSessionsFromDir } from '../adapters/opencode/adapter.js';
import { isValidSessionId } from '../core/fs-safe.js';
import { normalizeSession } from '../core/status.js';
import { readStateFile } from '../hooks/bridge.js';
import {
  MAX_EVENT_BYTES, RESERVED_AGENTS, validateEvent, eventToSignals, protocolFileName,
} from './schema.js';

export const protocolHooks = {
  id: 'event',
  name: 'LetItCook event protocol',
  maxInputBytes: MAX_EVENT_BYTES,

  target(input, now) {
    const result = validateEvent(input, { now });
    if (!result.ok || result.ignored) return null;
    const { agent, pid } = result.event;
    return { agent, pid, fileName: sessionId => protocolFileName(agent, sessionId) };
  },

  toSignals(input, now) {
    const result = validateEvent(input, { now });
    return result.ok && !result.ignored ? eventToSignals(result.event) : [];
  },
};

export class ProtocolAdapter extends BaseAdapter {
  constructor() {
    super('protocol', 'LetItCook event protocol');
  }

  // Producers report themselves; there is no executable to detect. The integration is in
  // use when at least one protocol session exists.
  isAvailable(options = {}) {
    return this.detectSessions(options).length > 0;
  }

  // Protocol sessions are those whose agent is not a native adapter's (producers cannot
  // use the reserved ids).
  detectSessions(options = {}) {
    const dir = options.baseDir || getSessionDir();
    return readAllSessionsFromDir(dir, options).filter(s => !RESERVED_AGENTS.has(s.agent));
  }

  getSessionState(sessionId, options = {}) {
    const agent = options.agent;
    if (!isValidSessionId(sessionId) || typeof agent !== 'string' || RESERVED_AGENTS.has(agent)) return null;
    const dir = options.baseDir || getSessionDir();
    const raw = readStateFile(path.join(dir, protocolFileName(agent, sessionId)), { sessionId, agent });
    return raw ? normalizeSession(raw, options) : null;
  }
}

export default { protocolHooks, ProtocolAdapter };
