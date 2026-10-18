// Hook-based adapters by agent id, as used on the command line of src/hooks/hook.js.
import { claudeHooks } from '../adapters/claude/hooks.js';

export const HOOK_ADAPTERS = Object.freeze({
  [claudeHooks.id]: claudeHooks,
});

export default HOOK_ADAPTERS;
