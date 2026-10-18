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
// `{ ok, error? }` for diagnostics (error codes only, never event values). Calls are
// synchronous: a few milliseconds, up to 2 s when another writer holds the session's lock
// (the event is then skipped, like with the command transport).

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
      applySignals(agent, eventToSignals(result.event), {
        stateDir: stateDir || getSessionDir(), now, pid, fileName: sid => protocolFileName(agent, sid),
      });
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
