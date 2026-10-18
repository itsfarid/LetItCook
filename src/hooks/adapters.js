// Hook-based adapters by agent id, as used on the command line of src/hooks/hook.js.
import { claudeHooks } from '../adapters/claude/hooks.js';
import { codexHooks } from '../adapters/codex/hooks.js';

export const HOOK_ADAPTERS = Object.freeze({
  [claudeHooks.id]: claudeHooks,
  [codexHooks.id]: codexHooks,
});

export default HOOK_ADAPTERS;
