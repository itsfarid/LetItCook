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
  events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest'],

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

    switch (event) {
      case 'UserPromptSubmit':
        return [{ ...base, type: SIGNAL.TURN_START }];
      case 'PreToolUse':
        return [{ ...base, type: SIGNAL.ACTIVITY, reason: `tool:${tool}` }];
      // PermissionRequest has no tool_use_id (schema), so the request is identified by its
      // tool call; the call's PostToolUse resolves it. Codex runs these hooks synchronously,
      // so a resolution cannot precede its request (`remember: false` lets an identical
      // later call ask again).
      case 'PermissionRequest':
        return [{ ...base, type: SIGNAL.REQUEST_OPEN, requestId: toolCallRequestId(input), reason: `permission:${tool}` }];
      case 'PostToolUse':
        return [
          { ...base, type: SIGNAL.REQUEST_CLOSE, requestId: toolCallRequestId(input), remember: false },
          { ...base, type: SIGNAL.ACTIVITY, reason: `tool:${tool}` },
        ];
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
