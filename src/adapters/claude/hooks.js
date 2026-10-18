// Claude Code adapter: maps Claude Code hook events (stdin JSON of a `command` hook,
// https://code.claude.com/docs/en/hooks) to lifecycle signals (src/core/lifecycle.js).
// Pure: no I/O, no state; src/hooks/bridge.js applies the signals.
//
// Only identifiers are taken from the input (session id, cwd, tool name, event-specific
// enums). Prompts, tool inputs and outputs, and assistant messages are never stored.

import { SIGNAL } from '../../core/lifecycle.js';
import { HookAdapter } from '../hook-adapter.js';

// Tool names are identifiers (Bash, Edit, mcp__server__tool); anything else is reduced.
function label(value, fallback = 'unknown') {
  if (typeof value !== 'string' || !value) return fallback;
  const clean = value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
  return clean || fallback;
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

export const claudeHooks = {
  id: 'claude',
  name: 'Claude Code',
  bins: ['claude'],
  binEnv: 'CLAUDE_BIN',
  // Hook events LetItCook registers for.
  events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'],

  toSignals(input) {
    if (!input || typeof input !== 'object') return [];
    const event = input.hook_event_name;
    if (typeof event !== 'string') return [];
    const base = { sessionId: input.session_id, cwd: str(input.cwd) };
    const tool = label(input.tool_name);

    switch (event) {
      case 'UserPromptSubmit':
        return [{ ...base, type: SIGNAL.TURN_START, title: str(input.session_title) }];
      case 'PreToolUse':
        return [{ ...base, type: SIGNAL.ACTIVITY, reason: `tool:${tool}` }];
      case 'PostToolUse':
      case 'PostToolUseFailure':
        return [{ ...base, type: SIGNAL.ACTIVITY, reason: `tool:${tool}` }];
      default:
        return [];
    }
  },
};

export class ClaudeAdapter extends HookAdapter {
  constructor() {
    super(claudeHooks);
  }
}

export default { claudeHooks, ClaudeAdapter };
