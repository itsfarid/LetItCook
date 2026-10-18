// Hook command for agents that report through hooks:
//
//   node src/hooks/hook.js <agent>     reads one hook event (JSON) on stdin
//
// It prints nothing and always exits 0, so it never changes what the agent does. See
// src/hooks/bridge.js.

import { runHook, readBoundedStdin } from './bridge.js';
import { HOOK_ADAPTERS } from './adapters.js';

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
