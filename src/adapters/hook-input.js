// Helpers for reading untrusted hook input in hook adapters. Only identifiers are taken
// from it; free text (prompts, tool inputs and outputs, messages) is never stored.

import { createHash } from 'node:crypto';

// Identifiers (tool names, agent ids, error codes) keep only [A-Za-z0-9_.:-].
export function label(value, fallback = 'unknown') {
  if (typeof value !== 'string' || !value) return fallback;
  const clean = value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
  return clean || fallback;
}

export function str(value) {
  return typeof value === 'string' ? value : '';
}

// Id of the permission request for one tool call, for agents whose permission event
// carries no tool call id: the agent (main or subagent), the tool and a digest of the tool
// input (the input itself is not stored). The tool call's later events resolve it. An
// identical later call gets the same id, so resolutions must use `remember: false`.
// Kept well under the 128-character request id limit so the digest is never cut off.
export function toolCallRequestId(input) {
  let digest = '';
  try {
    digest = createHash('sha256').update(JSON.stringify(input.tool_input ?? null) || '').digest('hex').slice(0, 16);
  } catch {}
  return `permission:${label(input.agent_id, 'main').slice(0, 32)}:${label(input.tool_name).slice(0, 32)}:${digest}`;
}

// Settings block shared by agents using the {"hooks": {Event: [{hooks: [...]}]}} format.
// Timeouts are in seconds; the hook itself takes well under one.
export function commandHooksConfig(events, command, timeoutSec = 10) {
  const hooks = {};
  for (const event of events) {
    hooks[event] = [{ hooks: [{ type: 'command', command, timeout: timeoutSec }] }];
  }
  return { hooks };
}

export default { label, str, toolCallRequestId, commandHooksConfig };
