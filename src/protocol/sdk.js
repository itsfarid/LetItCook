// Minimal Node.js helper for CLIs that report through the LetItCook event protocol
// in-process (docs/protocol.md). Other languages run `node src/hooks/hook.js event` with
// one JSON event on stdin instead.
//
//   import { createReporter } from '<clone>/src/protocol/sdk.js';
//   const report = createReporter({ agent: 'mycli', sessionId, capabilities: ['requests', 'complete', 'fail', 'cancel'] });
//   report.turnStarted();
//   const id = report.requestOpened({ kind: 'permission', subject: 'shell' });
//   report.requestResolved(id, 'approved');
//   report.turnCompleted();
//
// Every method validates the event and applies it through the shared bridge (same rules,
// lock and file safety as the command). It never throws into the host CLI; it returns
// `{ ok: true }` when LetItCook applied the event, or `{ ok: false, error }` (codes only,
// never event values) when it did not:
//   - a schema error code (e.g. `reserved_agent`, `invalid_subject`) for an invalid event;
//   - `ignored` when the state rules did not apply it: an outcome or request outside the
//     declared capabilities, a late or duplicate event, activity on a finished turn;
//   - `busy` when another writer held the session's lock for 2 s (the event is skipped);
//   - `write_failed` when the state directory is unusable.
// `requestOpened()` returns the request id only when the request was applied, else null:
// the caller must not treat it as shown in the panel. Calls are synchronous: a few
// milliseconds, up to 2 s while waiting for the lock.

import { randomUUID } from 'node:crypto';
import { applySignals } from '../hooks/bridge.js';
import { getSessionDir } from '../adapters/opencode/adapter.js';
import { validateEvent, eventToSignals, protocolFileName } from './schema.js';

export function createReporter({
  agent, sessionId, capabilities, cwd, parentSessionId, stateDir, pid = process.pid, clock = () => Date.now(),
} = {}) {
  const instance = randomUUID().slice(0, 8);
  let seq = 0;
  let turn = null;

  function emit(type, fields = {}) {
    try {
      // `clock` is the producer's clock (the event time); validation and the state files
      // use the receiving machine's clock, like the command transport.
      const now = Date.now();
      const event = {
        schema: 1, agent, session_id: sessionId, event_id: `${instance}-${++seq}`, type, time: clock(),
        ...(cwd ? { cwd } : {}),
        ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
        ...fields,
      };
      const result = validateEvent(event, { now });
      if (!result.ok) return { ok: false, error: result.error };
      if (result.ignored) return { ok: false, error: result.ignored };
      const outcomes = [];
      applySignals(agent, eventToSignals(result.event), {
        stateDir: stateDir || getSessionDir(), now, pid, fileName: sid => protocolFileName(agent, sid), outcomes,
      });
      if (outcomes.includes('busy')) return { ok: false, error: 'busy' };
      if (outcomes.length === 0 || outcomes.includes('ignored')) return { ok: false, error: 'ignored' };
      return { ok: true };
    } catch {
      return { ok: false, error: 'write_failed' };
    }
  }

  const inTurn = () => (turn ? { turn_id: turn } : {});
  const declared = capabilities ? { capabilities } : {};

  return {
    sessionStarted: () => emit('session.started', declared),
    turnStarted() {
      turn = `${instance}-t${seq + 1}`;
      return emit('turn.started', { turn_id: turn, ...declared });
    },
    activity: subject => emit('activity', subject ? { subject } : {}),
    // Returns the request id to resolve it with, or null when the event was rejected.
    requestOpened({ kind = 'permission', subject } = {}) {
      const requestId = `${instance}-r${seq + 1}`;
      const result = emit('request.opened', { ...inTurn(), request_id: requestId, kind, ...(subject ? { subject } : {}) });
      return result.ok ? requestId : null;
    },
    requestResolved: (requestId, outcome) => emit('request.resolved', { request_id: requestId, ...(outcome ? { outcome } : {}) }),
    turnCompleted: () => emit('turn.completed', inTurn()),
    turnFailed: errorCode => emit('turn.failed', { ...inTurn(), ...(errorCode ? { error_code: errorCode } : {}) }),
    turnCancelled: () => emit('turn.cancelled', inTurn()),
    turnEnded: () => emit('turn.ended', inTurn()),
    sessionEnded: () => emit('session.ended'),
    subagentStarted: subagentId => emit('subagent.started', { subagent_id: subagentId }),
    subagentStopped: subagentId => emit('subagent.stopped', { subagent_id: subagentId }),
  };
}

export default { createReporter };
