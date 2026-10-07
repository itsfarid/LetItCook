import { normalizeSession } from '../core/status.js';

export class BaseAdapter {
  constructor(id, name) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Adapter id must be a non-empty string');
    this.id = id;
    this.name = name || id;
  }

  isAvailable() {
    return false;
  }

  detectSessions(options = {}) {
    return [];
  }

  getSessionState(sessionId, options = {}) {
    return null;
  }

  normalizeState(raw, options = {}) {
    return normalizeSession({
      ...raw,
      agent: this.id,
    }, options);
  }

  startMonitoring(callback, options = {}) {
    // ponytail: override in adapter for push/fs monitoring, upgrade to EventEmitter if needed
  }

  stopMonitoring() {
    // ponytail: cleanup watchers/timers
  }
}

export default BaseAdapter;
