// Hook command for agents that report through hooks:
//
//   node src/hooks/hook.js <agent>                  reads one hook event (JSON) on stdin
//   node src/hooks/hook.js --print-config <agent>   prints the agent's hook settings
//
// As a hook it prints nothing and always exits 0, so it never changes what the agent
// does. See src/hooks/bridge.js. --print-config only prints; it never edits a file.

import { runHook, readBoundedStdin } from './bridge.js';
import { HOOK_ADAPTERS } from './adapters.js';
import { hookCommand } from './config.js';

if (process.argv[2] === '--print-config') {
  const target = process.argv[3];
  const hooks = Object.hasOwn(HOOK_ADAPTERS, target || '') ? HOOK_ADAPTERS[target] : null;
  if (!hooks || typeof hooks.config !== 'function') {
    console.error(`Usage: node src/hooks/hook.js --print-config <${Object.keys(HOOK_ADAPTERS).join('|')}>`);
    process.exit(2);
  }
  console.log(JSON.stringify(hooks.config(hookCommand(hooks.id)), null, 2));
  process.exit(0);
}

const agent = process.argv[2];
const adapter = Object.hasOwn(HOOK_ADAPTERS, agent || '') ? HOOK_ADAPTERS[agent] : null;
try {
  if (adapter) {
    await runHook(adapter);
  } else {
    // Unknown agent: still consume stdin so the agent never sees a broken pipe.
    await readBoundedStdin();
  }
} catch {}
process.exit(0);
