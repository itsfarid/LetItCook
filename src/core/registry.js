import { OpenCodeAdapter } from '../adapters/opencode/adapter.js';
import { CopilotAdapter } from '../adapters/copilot/adapter.js';
import { ClaudeAdapter } from '../adapters/claude/hooks.js';
import { CodexAdapter } from '../adapters/codex/hooks.js';
import { GeminiAdapter } from '../adapters/gemini/hooks.js';
import { aggregateState } from './status.js';

export class AdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(adapter) {
    if (!adapter || !adapter.id) {
      throw new Error('Adapter must have an id');
    }
    this.adapters.set(adapter.id, adapter);
  }

  unregister(id) {
    this.adapters.delete(id);
  }

  get(id) {
    return this.adapters.get(id) || null;
  }

  getAll() {
    return Array.from(this.adapters.values());
  }

  getAvailable() {
    return this.getAll().filter(a => {
      try {
        return a.isAvailable();
      } catch {
        return false;
      }
    });
  }

  detectAllSessions(options = {}) {
    const allSessions = [];
    for (const adapter of this.getAll()) {
      try {
        const sessions = adapter.detectSessions(options);
        if (Array.isArray(sessions)) {
          allSessions.push(...sessions);
        }
      } catch {}
    }
    return allSessions;
  }

  syncAll(targetStateDir, options = {}) {
    const syncedSessions = [];
    for (const adapter of this.getAll()) {
      if (typeof adapter.syncToStateDir === 'function') {
        try {
          const sessions = adapter.syncToStateDir(targetStateDir, options);
          if (Array.isArray(sessions)) {
            syncedSessions.push(...sessions);
          }
        } catch {}
      }
    }
    return syncedSessions;
  }

  getAggregatedState(options = {}) {
    const sessions = this.detectAllSessions(options);
    return aggregateState(sessions, options);
  }
}

export function createDefaultRegistry() {
  const registry = new AdapterRegistry();
  registry.register(new OpenCodeAdapter());
  registry.register(new CopilotAdapter());
  registry.register(new ClaudeAdapter());
  registry.register(new CodexAdapter());
  registry.register(new GeminiAdapter());
  return registry;
}

export const defaultRegistry = createDefaultRegistry();

export default {
  AdapterRegistry,
  createDefaultRegistry,
  defaultRegistry,
};
