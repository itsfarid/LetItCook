// Hook-based adapters by agent id, as used on the command line of src/hooks/hook.js.
import { claudeHooks } from '../adapters/claude/hooks.js';
import { codexHooks } from '../adapters/codex/hooks.js';
import { geminiHooks } from '../adapters/gemini/hooks.js';

export const HOOK_ADAPTERS = Object.freeze({
  [claudeHooks.id]: claudeHooks,
  [codexHooks.id]: codexHooks,
  [geminiHooks.id]: geminiHooks,
});

export default HOOK_ADAPTERS;
