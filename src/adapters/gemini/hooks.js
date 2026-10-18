// Gemini CLI adapter: maps Gemini CLI hook events (stdin JSON of a `command` hook,
// https://geminicli.com/docs/hooks/) to lifecycle signals (src/core/lifecycle.js). Pure:
// no I/O, no state; src/hooks/bridge.js applies the signals.
//
// Only identifiers are taken from the input (session id, cwd, tool name). Prompts, tool
// inputs and outputs, model traffic and messages are never stored.

import { SIGNAL } from '../../core/lifecycle.js';
import { HookAdapter } from '../hook-adapter.js';
import { label, str } from '../hook-input.js';

export const geminiHooks = {
  id: 'gemini',
  name: 'Gemini CLI',
  bins: ['gemini'],
  binEnv: 'GEMINI_BIN',
  // Hook events LetItCook registers for. BeforeModel/AfterModel are left out: AfterModel
  // fires for every streamed chunk.
  events: ['BeforeAgent', 'BeforeTool', 'AfterTool', 'Notification', 'AfterAgent', 'SessionEnd'],

  // Settings block for ~/.gemini/settings.json. Gemini timeouts are in milliseconds; the
  // name lets the user disable the hook with /hooks or hooksConfig.disabled.
  config(command) {
    const hooks = {};
    for (const event of this.events) {
      hooks[event] = [{ hooks: [{ type: 'command', name: `letitcook-${event}`, command, timeout: 10000 }] }];
    }
    return { hooks };
  },

  toSignals(input) {
    if (!input || typeof input !== 'object') return [];
    const event = input.hook_event_name;
    if (typeof event !== 'string') return [];
    const base = { sessionId: input.session_id, cwd: str(input.cwd) };
    const tool = label(input.tool_name);

    switch (event) {
      case 'BeforeAgent':
        return [{ ...base, type: SIGNAL.TURN_START }];
      // BeforeTool runs before the tool's confirmation, so it never resolves a request.
      case 'BeforeTool':
        return [{ ...base, type: SIGNAL.ACTIVITY, reason: `tool:${tool}` }];
      // Gemini executes no tool of a batch while any of its calls awaits approval (the
      // scheduler waits until every call is scheduled or finished), so a tool finishing
      // means the waiting confirmation was answered. Notifications carry no tool call id,
      // so this resolves every waiting request.
      case 'AfterTool':
        return [
          { ...base, type: SIGNAL.REQUEST_CLOSE },
          { ...base, type: SIGNAL.ACTIVITY, reason: `tool:${tool}` },
        ];
      // The only notification type is ToolPermission: a tool waits for confirmation. The
      // ask_user tool asks its question through the same confirmation.
      case 'Notification': {
        if (input.notification_type !== 'ToolPermission') return [];
        const kind = label(input.details && input.details.type, 'tool');
        const reason = kind === 'ask_user' ? 'question' : `permission:${kind}`;
        return [{ ...base, type: SIGNAL.REQUEST_OPEN, requestId: 'confirmation', reason }];
      }
      // AfterAgent fires when a prompt's turn is over, whether it succeeded, failed (API
      // error, loop detection, turn limit) or was cancelled while the model streamed. It
      // has no outcome field, so the turn is handed back without claiming Done or Burn.
      case 'AfterAgent':
        return [{ ...base, type: SIGNAL.TURN_END, reason: 'turn ended' }];
      case 'SessionEnd':
        return [{ ...base, type: SIGNAL.SESSION_END }];
      default:
        return [];
    }
  },
};

export class GeminiAdapter extends HookAdapter {
  constructor() {
    super(geminiHooks);
  }
}

export default { geminiHooks, GeminiAdapter };
