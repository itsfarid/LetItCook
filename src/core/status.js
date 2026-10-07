export const STATUS = Object.freeze({
  COOKING: 'cooking',
  YOUR_TURN: 'your_turn',
  DONE: 'done',
  BURN: 'burn',
  UNKNOWN: 'unknown',
});

export const STATUS_META = Object.freeze({
  [STATUS.COOKING]: Object.freeze({ label: 'Cooking', emoji: '🟡', indicator: '🟡 Cooking', priority: 3, color: '#f1c40f' }),
  [STATUS.YOUR_TURN]: Object.freeze({ label: 'Your Turn', emoji: '🟠', indicator: '🟠 Your Turn', priority: 4, color: '#e67e22' }),
  [STATUS.DONE]: Object.freeze({ label: 'Done', emoji: '🟢', indicator: '🟢 Done', priority: 2, color: '#2ecc71' }),
  [STATUS.BURN]: Object.freeze({ label: 'Burn', emoji: '🔴', indicator: '🔴 Burn', priority: 5, color: '#e74c3c' }),
  [STATUS.UNKNOWN]: Object.freeze({ label: 'Unknown', emoji: '⚪', indicator: '⚪ Unknown', priority: 1, color: '#95a5a6' }),
});

export const DEFAULT_STALE_MS = 5 * 60 * 1000;

export function isValidStatus(status) {
  return Object.values(STATUS).includes(status);
}

export function normalizeSession(raw, options = {}) {
  if (!raw || typeof raw !== 'object') {
    return {
      session_id: 'unknown',
      agent: 'unknown',
      status: STATUS.UNKNOWN,
      reason: 'invalid session data',
      title: '',
      cwd: '',
      pid: null,
      created_at: 0,
      updated_at: 0,
      stale: true,
      terminated: true,
      confidence: 'low',
    };
  }

  const now = options.now || Date.now();
  const staleMs = options.staleMs || DEFAULT_STALE_MS;
  const isPidAlive = options.isPidAlive || null;

  const sessionId = String(raw.session_id || raw.sid || 'unknown');
  const agent = String(raw.agent || 'unknown');
  const title = String(raw.title || raw.sessionTitle || '');
  const cwd = String(raw.cwd || raw.directory || '');
  const pid = typeof raw.pid === 'number' && Number.isInteger(raw.pid) ? raw.pid : null;
  const createdAt = typeof raw.created_at === 'number' ? raw.created_at : (typeof raw.since === 'number' ? raw.since : now);
  const updatedAt = typeof raw.updated_at === 'number' ? raw.updated_at : (typeof raw.lastEvent === 'number' ? raw.lastEvent : createdAt);
  const reason = String(raw.reason || raw.status || '');
  const confidence = String(raw.confidence || (raw.status && isValidStatus(raw.status) ? 'high' : 'low'));

  if (raw.deleted) {
    return {
      session_id: sessionId,
      agent,
      status: STATUS.UNKNOWN,
      reason: 'session deleted',
      title,
      cwd,
      pid,
      created_at: createdAt,
      updated_at: updatedAt,
      stale: true,
      terminated: true,
      confidence: 'high',
    };
  }

  let status = raw.status;
  const explicitTerminated = raw.terminated === true;
  if (!isValidStatus(status)) {
    status = STATUS.UNKNOWN;
  }

  let stale = false;
  let terminated = explicitTerminated;

  const hasPid = pid !== null;
  const pidAlive = hasPid && isPidAlive ? isPidAlive(pid) : true;

  if (!terminated && hasPid && isPidAlive && !pidAlive) {
    if (status === STATUS.DONE || status === STATUS.BURN) {
      terminated = true;
    } else if (status === STATUS.COOKING || status === STATUS.YOUR_TURN) {
      stale = true;
      status = STATUS.UNKNOWN;
    }
  }

  if (!terminated && (status === STATUS.COOKING || status === STATUS.YOUR_TURN)) {
    if (now - updatedAt > staleMs) {
      stale = true;
      status = STATUS.UNKNOWN;
    }
  }

  return {
    session_id: sessionId,
    agent,
    status,
    reason,
    title,
    cwd,
    pid,
    created_at: createdAt,
    updated_at: updatedAt,
    stale,
    terminated,
    confidence,
  };
}

export function aggregateState(sessions = [], options = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return {
      status: STATUS.UNKNOWN,
      meta: STATUS_META[STATUS.UNKNOWN],
      sessionCount: 0,
      activeCount: 0,
      sessions: [],
    };
  }

  // Filter out terminated sessions
  const normalizedList = sessions
    .map(s => normalizeSession(s, options))
    .filter(s => !s.terminated);

  if (normalizedList.length === 0) {
    return {
      status: STATUS.UNKNOWN,
      meta: STATUS_META[STATUS.UNKNOWN],
      sessionCount: 0,
      activeCount: 0,
      sessions: [],
    };
  }

  let topPriority = 0;
  let dominantStatus = STATUS.UNKNOWN;
  let activeCount = 0;

  for (const session of normalizedList) {
    if (session.status === STATUS.COOKING || session.status === STATUS.YOUR_TURN) {
      activeCount++;
    }
    const meta = STATUS_META[session.status] || STATUS_META[STATUS.UNKNOWN];
    if (meta.priority > topPriority) {
      topPriority = meta.priority;
      dominantStatus = session.status;
    }
  }

  // ponytail: sort by priority desc then updated_at desc, upgrade when custom ordering requested
  normalizedList.sort((a, b) => {
    const pA = (STATUS_META[a.status] || STATUS_META[STATUS.UNKNOWN]).priority;
    const pB = (STATUS_META[b.status] || STATUS_META[STATUS.UNKNOWN]).priority;
    if (pA !== pB) return pB - pA;
    return b.updated_at - a.updated_at;
  });

  return {
    status: dominantStatus,
    meta: STATUS_META[dominantStatus] || STATUS_META[STATUS.UNKNOWN],
    sessionCount: normalizedList.length,
    activeCount,
    sessions: normalizedList,
  };
}

export default {
  STATUS,
  STATUS_META,
  DEFAULT_STALE_MS,
  isValidStatus,
  normalizeSession,
  aggregateState,
};
