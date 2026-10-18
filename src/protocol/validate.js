// Dry-run validator for protocol producers (docs/protocol.md, onboarding step 2):
//
//   node src/protocol/validate.js events.jsonl
//
// Reads one event per line, validates each like `hook.js event`, applies the accepted ones
// to in-memory sessions through the shared reducer and prints, per line, whether it was
// accepted, ignored or rejected (with a reason code) and the session's state afterwards,
// then the states each session reached. It writes nothing and never echoes event values
// beyond validated identifiers. Event times are checked against the time of the first
// event, so recorded files can be validated later. Exits 1 if any line was rejected.

import fs from 'node:fs';
import { reduceSession } from '../core/lifecycle.js';
import { MAX_EVENT_BYTES, validateEvent, eventToSignals } from './schema.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;

export function validateLines(lines) {
  const sessions = new Map();
  const results = [];
  let reference = null;
  lines.forEach((line, index) => {
    const number = index + 1;
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES) {
      results.push({ line: number, result: 'rejected', reason: 'oversized' });
      return;
    }
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      results.push({ line: number, result: 'rejected', reason: 'invalid_json' });
      return;
    }
    if (reference === null && raw && Number.isSafeInteger(raw.time)) reference = raw.time;
    const checked = validateEvent(raw, { now: reference ?? Date.now() });
    if (!checked.ok) {
      results.push({ line: number, result: 'rejected', reason: checked.error });
      return;
    }
    const { event } = checked;
    const key = `${event.agent}/${event.session_id}`;
    if (checked.ignored) {
      results.push({ line: number, result: 'ignored', reason: checked.ignored, session: key });
      return;
    }
    const entry = sessions.get(key) || { state: null, reached: new Set() };
    let changed = false;
    for (const signal of eventToSignals(event)) {
      const next = reduceSession(entry.state, signal, { agent: event.agent, now: event.time });
      if (next) {
        entry.state = next.deleted ? null : next;
        changed = true;
      }
    }
    const status = entry.state ? entry.state.status : 'removed';
    if (entry.state) entry.reached.add(status);
    sessions.set(key, entry);
    results.push({ line: number, result: changed ? 'accepted' : 'no_effect', type: event.type, session: key, status });
  });
  const summary = [...sessions].map(([key, entry]) => ({
    session: key,
    reached: [...entry.reached].sort(),
    capabilities: entry.state?.capabilities ?? null,
  }));
  return { results, summary, rejected: results.filter(r => r.result === 'rejected').length };
}

function main(file) {
  if (!file) {
    console.error('Usage: node src/protocol/validate.js <events.jsonl>');
    return 2;
  }
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) {
      console.error('Not a regular file of at most 4 MiB.');
      return 2;
    }
    text = fs.readFileSync(file, 'utf8');
  } catch {
    console.error('Cannot read the file.');
    return 2;
  }
  const { results, summary, rejected } = validateLines(text.split('\n'));
  for (const r of results) {
    const what = r.result === 'rejected' || r.result === 'ignored' ? `${r.result} (${r.reason})` : `${r.result} ${r.type}`;
    console.log(`line ${r.line}: ${what}${r.session ? ` ${r.session}` : ''}${r.status ? ` -> ${r.status}` : ''}`);
  }
  for (const s of summary) {
    console.log(`${s.session}: reached ${s.reached.join(', ') || 'nothing'}; capabilities ${s.capabilities ? s.capabilities.join(', ') || 'none' : 'not declared'}`);
  }
  console.log(rejected ? `${rejected} event(s) rejected.` : 'All events valid.');
  return rejected ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv[2]);
}

export default { validateLines };
