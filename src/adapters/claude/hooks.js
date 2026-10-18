// Claude Code adapter: maps Claude Code hook events (stdin JSON of a `command` hook,
// https://code.claude.com/docs/en/hooks) to lifecycle signals (src/core/lifecycle.js).
// Pure: no I/O, no state; src/hooks/bridge.js applies the signals.

import { HookAdapter } from '../hook-adapter.js';

export const claudeHooks = {
  id: 'claude',
  name: 'Claude Code',
  bins: ['claude'],
  binEnv: 'CLAUDE_BIN',
  // Hook events LetItCook registers for.
  events: [],
  toSignals(input) {
    return [];
  },
};

export class ClaudeAdapter extends HookAdapter {
  constructor() {
    super(claudeHooks);
  }
}

export default { claudeHooks, ClaudeAdapter };
