// Claude Code adapter: maps Claude Code hook events (stdin JSON of a `command` hook,
// https://code.claude.com/docs/en/hooks) to lifecycle signals (src/core/lifecycle.js).
// Pure: no I/O, no state; src/hooks/bridge.js applies the signals.
//
// Only identifiers are taken from the input (session id, cwd, tool name, event-specific
// enums). Prompts, tool inputs and outputs, and assistant messages are never stored.

import { createHash } from 'node:crypto';
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

// PermissionRequest has no tool_use_id, so a permission is identified by the tool call it
// is for: agent, tool and a digest of the tool input (the input itself is not stored).
// PostToolUse / PostToolUseFailure / PermissionDenied of the same call resolve it. An
// identical later call gets the same id, so resolutions are not remembered
// (`remember: false`); Claude Code runs hooks synchronously, so a resolution cannot
// arrive before its request.
function permissionId(input) {
  let digest = '';
  try {
    digest = createHash('sha256').update(JSON.stringify(input.tool_input ?? null) || '').digest('hex').slice(0, 16);
  } catch {}
  // Kept well under the 128-character request id limit so the digest is never cut off.
  return `permission:${label(input.agent_id, 'main').slice(0, 32)}:${label(input.tool_name).slice(0, 32)}:${digest}`;
}

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
  ],

  toSignals(input) {
    if (!input || typeof input !== 'object') return [];
    const event = input.hook_event_name;
    if (typeof event !== 'string') return [];
    const base = { sessionId: input.session_id, cwd: str(input.cwd) };
    const tool = label(input.tool_name);
    const questionId = `question:${label(input.tool_use_id)}`;
    const elicitationId = `elicitation:${label(input.elicitation_id, label(input.mcp_server_name))}`;

    switch (event) {
      case 'UserPromptSubmit':
        return [{ ...base, type: SIGNAL.TURN_START, title: str(input.session_title) }];
      case 'PreToolUse': {
        const signals = [{ ...base, type: SIGNAL.ACTIVITY, reason: `tool:${tool}` }];
        // The question is shown to the user while this tool runs.
        if (input.tool_name === QUESTION_TOOL) signals.push({ ...base, type: SIGNAL.REQUEST_OPEN, requestId: questionId, reason: 'question' });
        return signals;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied': {
        const signals = [{ ...base, type: SIGNAL.REQUEST_CLOSE, requestId: permissionId(input), remember: false }];
        if (input.tool_name === QUESTION_TOOL) signals.push({ ...base, type: SIGNAL.REQUEST_CLOSE, requestId: questionId, remember: false });
        signals.push({ ...base, type: SIGNAL.ACTIVITY, reason: `tool:${tool}` });
        return signals;
      }
      case 'PermissionRequest':
        return [{ ...base, type: SIGNAL.REQUEST_OPEN, requestId: permissionId(input), reason: `permission:${tool}` }];
      case 'Elicitation':
        return [{ ...base, type: SIGNAL.REQUEST_OPEN, requestId: elicitationId, reason: `elicitation:${label(input.mcp_server_name, 'mcp')}` }];
      case 'ElicitationResult':
        return [{ ...base, type: SIGNAL.REQUEST_CLOSE, requestId: elicitationId, remember: false }];
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
