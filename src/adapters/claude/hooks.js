// Claude Code adapter: maps Claude Code hook events (stdin JSON of a `command` hook,
// https://code.claude.com/docs/en/hooks) to lifecycle signals (src/core/lifecycle.js).
// Pure: no I/O, no state; src/hooks/bridge.js applies the signals.
//
// Only identifiers are taken from the input (session id, cwd, tool name, event-specific
// enums). Prompts, tool inputs and outputs, and assistant messages are never stored.

import { SIGNAL } from '../../core/lifecycle.js';
import { HookAdapter } from '../hook-adapter.js';
import { label, str, toolCallRequestId, commandHooksConfig } from '../hook-input.js';

// PermissionRequest has no tool_use_id, so a permission is identified by its tool call
// (toolCallRequestId). PostToolUse / PostToolUseFailure / PermissionDenied of the same
// call resolve it with `remember: false`; Claude Code runs hooks synchronously, so a
// resolution cannot arrive before its request.
const permissionId = toolCallRequestId;

const QUESTION_TOOL = 'AskUserQuestion';

export const claudeHooks = {
  id: 'claude',
  name: 'Claude Code',
  bins: ['claude'],
  binEnv: 'CLAUDE_BIN',
  // Hook events LetItCook registers for.
  events: [
    'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'PermissionDenied', 'Elicitation', 'ElicitationResult',
    'Stop', 'StopFailure', 'SessionEnd', 'SubagentStart', 'SubagentStop',
  ],

  // Settings block for ~/.claude/settings.json (or a project's .claude/settings.json):
  // one synchronous command hook per event, so events keep their order. None of these
  // events needs a matcher.
  config(command) {
    return commandHooksConfig(this.events, command);
  },

  toSignals(input) {
    if (!input || typeof input !== 'object') return [];
    const event = input.hook_event_name;
    if (typeof event !== 'string') return [];
    const base = { sessionId: input.session_id, cwd: str(input.cwd) };
    // Subagents share the parent's session_id; their tool events carry agent_id. They are
    // activity of the parent session and never complete, fail or cancel it.
    const subagent = typeof input.agent_id === 'string' && input.agent_id !== '';
    const tool = label(input.tool_name);
    const questionId = `question:${label(input.tool_use_id)}`;
    const elicitationId = `elicitation:${label(input.elicitation_id, label(input.mcp_server_name))}`;

    switch (event) {
      case 'UserPromptSubmit':
        // session_title is generated from the prompt, so it is not stored either.
        return [{ ...base, type: SIGNAL.TURN_START }];
      case 'PreToolUse': {
        // The main agent starting a tool is new work even after Stop: Claude Code continues
        // a turn when another Stop hook blocks it, without a new prompt.
        const signals = [{ ...base, type: SIGNAL.ACTIVITY, reason: `tool:${tool}`, subagent, revive: !subagent }];
        // The question is shown to the user while this tool runs.
        if (input.tool_name === QUESTION_TOOL) signals.push({ ...base, type: SIGNAL.REQUEST_OPEN, requestId: questionId, reason: 'question' });
        return signals;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied': {
        const signals = [{ ...base, type: SIGNAL.REQUEST_CLOSE, requestId: permissionId(input), remember: false }];
        if (input.tool_name === QUESTION_TOOL) signals.push({ ...base, type: SIGNAL.REQUEST_CLOSE, requestId: questionId, remember: false });
        if (event === 'PostToolUseFailure' && input.is_interrupt === true) {
          // The user interrupted the turn (Esc) while this tool ran; Stop does not fire.
          signals.push({ ...base, type: SIGNAL.CANCEL, reason: 'interrupted', subagent });
        } else {
          signals.push({ ...base, type: SIGNAL.ACTIVITY, reason: `tool:${tool}`, subagent });
        }
        return signals;
      }
      case 'PermissionRequest':
        return [{ ...base, type: SIGNAL.REQUEST_OPEN, requestId: permissionId(input), reason: `permission:${tool}` }];
      case 'Elicitation':
        return [{ ...base, type: SIGNAL.REQUEST_OPEN, requestId: elicitationId, reason: `elicitation:${label(input.mcp_server_name, 'mcp')}` }];
      case 'ElicitationResult':
        return [{ ...base, type: SIGNAL.REQUEST_CLOSE, requestId: elicitationId, remember: false }];
      // Stop: the main agent finished responding. It does not fire on a user interrupt,
      // and API errors fire StopFailure instead.
      case 'Stop':
        return [{ ...base, type: SIGNAL.TURN_COMPLETE, reason: 'turn completed' }];
      case 'StopFailure':
        return [{ ...base, type: SIGNAL.FAILURE, reason: `error:${label(input.error)}` }];
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

export class ClaudeAdapter extends HookAdapter {
  constructor() {
    super(claudeHooks);
  }
}

export default { claudeHooks, ClaudeAdapter };
