#!/usr/bin/env node
// Reference producer for the LetItCook event protocol (docs/protocol.md). It plays a fake
// coding CLI session and reports it the way a CLI in any language would: one
// `node src/hooks/hook.js event` process per event, JSON on stdin. No model or API key.
//
//   node examples/protocol-producer.mjs [--scenario success|permission|failure|cancel|limited]
//                                       [--agent fake-cli] [--delay 1500] [--keep]
//                                       [--record events.jsonl] [--dry-run]
//
//   --keep      after the scenario, keep the fake CLI running (its final state stays in
//               the panel) until Ctrl+C or SIGTERM, then end the session
//   --record    also append every event to a JSON Lines file (for src/protocol/validate.js)
//   --dry-run   only record; send nothing to LetItCook

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../src/hooks/hook.js', import.meta.url));

const SCENARIOS = {
  // Each step: [type, extra fields]. The producer adds the envelope.
  success: [['turn.started'], ['activity', { subject: 'read' }], ['activity', { subject: 'edit' }], ['turn.completed']],
  permission: [
    ['turn.started'], ['activity', { subject: 'plan' }],
    ['request.opened', { request: 'p1', kind: 'permission', subject: 'shell' }], ['pause'],
    ['request.resolved', { request: 'p1', outcome: 'approved' }], ['activity', { subject: 'shell' }],
    ['request.opened', { request: 'q1', kind: 'question' }], ['pause'],
    ['request.resolved', { request: 'q1', outcome: 'answered' }], ['turn.completed'],
  ],
  failure: [['turn.started'], ['activity', { subject: 'shell' }], ['turn.failed', { error_code: 'rate_limit' }]],
  cancel: [['turn.started'], ['activity', { subject: 'shell' }], ['turn.cancelled']],
  // A producer that cannot tell success from failure: it declares no outcome and ends
  // turns with turn.ended (Your Turn), never Done.
  limited: [['turn.started'], ['activity'], ['turn.ended']],
};
const FULL = ['cancel', 'complete', 'fail', 'requests'];

function parseArgs(argv) {
  const opts = { scenario: 'permission', agent: 'fake-cli', delay: 1500, keep: false, record: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scenario') opts.scenario = argv[++i];
    else if (arg === '--agent') opts.agent = argv[++i];
    else if (arg === '--delay') opts.delay = Number(argv[++i]);
    else if (arg === '--record') opts.record = argv[++i];
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!SCENARIOS[opts.scenario]) throw new Error(`unknown scenario ${opts.scenario}`);
  if (!Number.isFinite(opts.delay) || opts.delay < 0) throw new Error('invalid --delay');
  return opts;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const session = `fake-${randomUUID().slice(0, 8)}`;
  const turn = 't1';
  let n = 0;
  const send = (type, fields = {}) => {
    const event = { schema: 1, agent: opts.agent, session_id: session, event_id: `${session}-${++n}`, type, time: Date.now(), ...fields };
    if (opts.record) fs.appendFileSync(opts.record, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    if (!opts.dryRun) spawnSync(process.execPath, [HOOK, 'event'], { input: JSON.stringify(event), stdio: ['pipe', 'ignore', 'ignore'] });
    console.log(`${session}: ${type}`);
  };

  const capabilities = opts.scenario === 'limited' ? [] : FULL;
  send('session.started', { capabilities, cwd: process.cwd() });
  for (const [type, extra = {}] of SCENARIOS[opts.scenario]) {
    if (type === 'pause') {
      await sleep(opts.delay * 2);
      continue;
    }
    const { request, ...rest } = extra;
    const fields = { ...rest };
    if (type.startsWith('turn.') || type === 'request.opened') fields.turn_id = turn;
    if (type === 'turn.started') {
      fields.capabilities = capabilities;
      fields.cwd = process.cwd();
    }
    if (request) fields.request_id = `${session}-${request}`;
    send(type, fields);
    await sleep(opts.delay);
  }
  if (opts.keep) {
    // The panel watches this process: while it runs, the final state stays visible.
    console.log(`${session}: waiting (Ctrl+C ends the session)`);
    await new Promise((resolve) => {
      const timer = setInterval(() => {}, 60 * 1000);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearInterval(timer); resolve(); });
    });
  }
  send('session.ended');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
