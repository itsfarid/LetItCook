// Codex CLI adapter: maps Codex hook events (stdin JSON of a `command` hook; schemas in
// openai/codex codex-rs/hooks/schema/generated, docs https://learn.chatgpt.com/docs/hooks)
// to lifecycle signals (src/core/lifecycle.js). Pure: no I/O, no state;
// src/hooks/bridge.js applies the signals.
//
// Only identifiers are taken from the input (session id, cwd, tool name). Prompts, tool
// inputs and outputs, and assistant messages are never stored.

import { SIGNAL } from '../../core/lifecycle.js';
import { HookAdapter } from '../hook-adapter.js';
import { label, str, toolCallRequestId, commandHooksConfig } from '../hook-input.js';

export const codexHooks = {
  id: 'codex',
  name: 'Codex CLI',
  bins: ['codex'],
  binEnv: 'CODEX_BIN',
  // Hook events LetItCook registers for.
  events: [
    'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
    'Stop', 'Interrupt', 'SessionEnd', 'SubagentStart', 'SubagentStop',
  ],

  // Settings block for ~/.codex/hooks.json. Codex runs non-managed hooks only after the
  // user trusts them in /hooks. Timeouts are 3 s, the maximum Codex allows for SessionEnd
  // and Interrupt hooks.
  config(command) {
    return commandHooksConfig(this.events, command, 3);
  },

  toSignals(input) {
    if (!input || typeof input !== 'object') return [];
    const event = input.hook_event_name;
    if (typeof event !== 'string') return [];
    const base = { sessionId: input.session_id, cwd: str(input.cwd) };
    const tool = label(input.tool_name);
    // Spawned subagents share the parent's session_id; their events carry agent_id. They
    // are activity of the parent session and never complete or cancel it.
    const subagent = typeof input.agent_id === 'string' && input.agent_id !== '';

    switch (event) {
      case 'UserPromptSubmit':
        return subagent
          ? [{ ...base, type: SIGNAL.ACTIVITY, reason: 'subagent', subagent }]
          : [{ ...base, type: SIGNAL.TURN_START }];
      case 'PreToolUse':
        // The main agent starting a tool is new work even after Stop: a Stop hook can make
        // Codex continue its turn.
        return [{ ...base, type: SIGNAL.ACTIVITY, reason: `tool:${tool}`, subagent, revive: !subagent }];
      // PermissionRequest has no tool_use_id (schema), so the request is identified by its
      // tool call; the call's PostToolUse resolves it. Codex runs these hooks synchronously,
      // so a resolution cannot precede its request (`remember: false` lets an identical
      // later call ask again).
      case 'PermissionRequest':
        return [{ ...base, type: SIGNAL.REQUEST_OPEN, requestId: toolCallRequestId(input), reason: `permission:${tool}` }];
      case 'PostToolUse':
        return [
          { ...base, type: SIGNAL.REQUEST_CLOSE, requestId: toolCallRequestId(input), remember: false },
          { ...base, type: SIGNAL.ACTIVITY, reason: `tool:${tool}`, subagent },
        ];
      // Stop runs only when a turn finishes normally: an errored turn ends without it and
      // an interrupted one runs Interrupt instead (codex-rs core/src/session/turn.rs).
      // Subagents run SubagentStop instead of Stop.
      case 'Stop':
        return [{ ...base, type: SIGNAL.TURN_COMPLETE, reason: 'turn completed' }];
      case 'Interrupt':
        return [{ ...base, type: SIGNAL.CANCEL, reason: 'interrupted' }];
      case 'SessionEnd':
        return [{ ...base, type: SIGNAL.SESSION_END }];
      case 'SubagentStart':
      case 'SubagentStop':
        return [{ ...base, type: SIGNAL.ACTIVITY, reason: `subagent:${label(input.agent_type, 'agent')}`, subagent: true }];
      default:
        return [];
    }
  },
};

export class CodexAdapter extends HookAdapter {
  constructor() {
    super(codexHooks);
  }
}

export default { codexHooks, CodexAdapter };
