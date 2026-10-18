// Builds the hook command line and settings that `node src/hooks/hook.js --print-config`
// prints for the user to merge into an agent's configuration. Nothing here edits files.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_SCRIPT = fileURLToPath(new URL('./hook.js', import.meta.url));

// POSIX shell single-quoting: agents run the command through a shell.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Absolute node binary and script, so the hook does not depend on the agent's PATH.
export function hookCommand(agent, { node = process.execPath, script = HOOK_SCRIPT } = {}) {
  return [node, path.resolve(script), agent].map(shellQuote).join(' ');
}

export default { shellQuote, hookCommand };
