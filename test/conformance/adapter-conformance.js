// Reusable adapter conformance suite. Every adapter (plugin, replay or hook based) is
// described by a spec:
//
//   {
//     id,                        agent id written to session files
//     step(prev, event, now),    applies one provider event; returns the next state, or
//                                null when nothing changes
//     fixtures: { name(sid, n) -> provider event, or null when the provider has no such
//                 event (the scenario is then reported as not applicable) },
//     expect: { cancel },        documented status after a user cancel
//     notes: { scenario: why },  documented reason an assertion does not apply
//                                (unrelatedActivity, lateToolEvent)
//     createAdapter(),           registry adapter (isAvailable / detectSessions)
//     sourceFiles: [...],        adapter sources, checked for network/process use
//     replayThroughFiles(sid, events) -> statuses after each event, via the state file
//                                (hook adapters; one process per event)
//   }
//
// Fixtures are synthetic events built from each provider's documented schema. The suite
// asserts only the shared invariants; provider-specific mapping is tested next to each
// adapter.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATUS } from '../../src/core/status.js';

export const SECRET = 'sk-LETITCOOK-CONFORMANCE-SECRET-0123456789';

const FIXTURE_NAMES = [
  'promptSubmit', 'toolStart', 'toolEnd', 'permissionAsk', 'permissionResolve', 'questionAsk',
  'questionResolve', 'turnComplete', 'turnEndUnknown', 'failure', 'cancel', 'sessionEnd',
  'subagentActivity', 'subagentComplete', 'subagentFailure',
];

function statusOf(state) {
  if (!state) return null;
  if (state.deleted) return 'removed';
  return state.status;
}

class Harness {
  constructor(spec) {
    this.spec = spec;
    this.states = new Map();
    this.now = Date.now();
  }

  apply(sid, event) {
    if (!event) return this.states.get(sid) || null;
    this.now += 1000;
    const prev = this.states.get(sid) || null;
    const next = this.spec.step(prev, event, this.now);
    if (next) this.states.set(sid, next);
    return this.states.get(sid) || null;
  }

  fx(name, sid, n = 1) {
    const make = this.spec.fixtures[name];
    return typeof make === 'function' ? make(sid, n) : null;
  }

  run(sid, ...names) {
    let state = null;
    for (const entry of names) {
      const [name, n] = Array.isArray(entry) ? entry : [entry, 1];
      state = this.apply(sid, this.fx(name, sid, n));
    }
    return state;
  }

  status(sid) {
    return statusOf(this.states.get(sid));
  }
}

export function runConformance(spec) {
  const notApplicable = [];
  const has = (...names) => {
    const missing = names.filter(name => typeof spec.fixtures[name] !== 'function' || spec.fixtures[name]('probe', 1) === null);
    if (missing.length) notApplicable.push(`${names.join('+')} (no ${missing.join(', ')} event)`);
    return missing.length === 0;
  };
  const fresh = () => new Harness(spec);
  const label = msg => `[${spec.id}] ${msg}`;

  for (const name of Object.keys(spec.fixtures)) {
    assert.ok(FIXTURE_NAMES.includes(name), label(`unknown fixture ${name}`));
  }

  // Malformed, empty and unknown events never throw and never invent a state.
  {
    const h = fresh();
    for (const bad of [null, undefined, {}, [], 'x', 42, ...(spec.malformed || [])]) {
      let result;
      assert.doesNotThrow(() => { result = spec.step(null, bad, Date.now()); }, label('malformed event throws'));
      assert.ok(![STATUS.DONE, STATUS.BURN, STATUS.YOUR_TURN].includes(statusOf(result)), label(`malformed event invents a state: ${JSON.stringify(bad)}`));
    }
    if (has('promptSubmit')) {
      h.run('s1', 'promptSubmit');
      for (const bad of [{}, ...(spec.malformed || [])]) {
        const before = h.status('s1');
        assert.doesNotThrow(() => h.apply('s1', bad));
        assert.strictEqual(h.status('s1'), before, label('a malformed event changes an existing session'));
      }
    }
  }

  // Activity.
  if (has('promptSubmit')) {
    assert.strictEqual(fresh().run('s1', 'promptSubmit').status, STATUS.COOKING, label('prompt -> Cooking'));
  }
  if (has('toolStart', 'toolEnd')) {
    const h = fresh();
    assert.strictEqual(h.run('s1', 'promptSubmit', 'toolStart').status, STATUS.COOKING, label('tool start -> Cooking'));
    assert.strictEqual(h.run('s1', 'toolEnd').status, STATUS.COOKING, label('tool end -> Cooking'));
  }

  // Permission requests: set Your Turn, cleared only by their resolution.
  if (has('promptSubmit', 'permissionAsk', 'permissionResolve')) {
    const h = fresh();
    h.run('s1', 'promptSubmit');
    assert.strictEqual(h.run('s1', 'permissionAsk').status, STATUS.YOUR_TURN, label('permission -> Your Turn'));
    if (spec.notes?.unrelatedActivity) {
      notApplicable.push(`unrelated activity during a permission (${spec.notes.unrelatedActivity})`);
    } else if (has('toolStart', 'toolEnd')) {
      assert.strictEqual(h.run('s1', ['toolStart', 2], ['toolEnd', 2]).status, STATUS.YOUR_TURN, label('unrelated tool activity hides a permission request'));
    }
    assert.strictEqual(h.run('s1', 'permissionResolve').status, STATUS.COOKING, label('resolved permission -> Cooking'));
  }
  if (has('promptSubmit', 'questionAsk', 'questionResolve')) {
    const h = fresh();
    assert.strictEqual(h.run('s1', 'promptSubmit', 'questionAsk').status, STATUS.YOUR_TURN, label('question -> Your Turn'));
    assert.strictEqual(h.run('s1', 'questionResolve').status, STATUS.COOKING, label('answered question -> Cooking'));
  }

  // Completion and its resistance to late and duplicate events.
  if (has('promptSubmit', 'turnComplete')) {
    const h = fresh();
    assert.strictEqual(h.run('s1', 'promptSubmit', 'toolStart', 'toolEnd', 'turnComplete').status, STATUS.DONE, label('turn complete -> Done'));
    assert.strictEqual(h.run('s1', 'turnComplete').status, STATUS.DONE, label('duplicate completion'));
    if (spec.notes?.lateToolEvent) {
      notApplicable.push(`late tool event after Done (${spec.notes.lateToolEvent})`);
    } else if (has('toolEnd')) {
      assert.strictEqual(h.run('s1', 'toolEnd').status, STATUS.DONE, label('a late tool event regresses Done'));
    }
    assert.strictEqual(h.run('s1', 'promptSubmit').status, STATUS.COOKING, label('a new prompt leaves Done'));
  }
  if (has('promptSubmit', 'turnEndUnknown')) {
    const status = fresh().run('s1', 'promptSubmit', 'turnEndUnknown').status;
    assert.notStrictEqual(status, STATUS.DONE, label('a turn end without outcome is Done'));
    assert.notStrictEqual(status, STATUS.BURN, label('a turn end without outcome is Burn'));
  }

  // Failure and cancellation.
  if (has('promptSubmit', 'failure')) {
    assert.strictEqual(fresh().run('s1', 'promptSubmit', 'failure').status, STATUS.BURN, label('explicit failure -> Burn'));
  }
  if (has('promptSubmit', 'cancel')) {
    assert.ok(spec.expect && spec.expect.cancel, label('expect.cancel must document the cancel status'));
    assert.strictEqual(fresh().run('s1', 'promptSubmit', 'cancel').status, spec.expect.cancel, label('cancel'));
  }

  // Session end without a trustworthy completion is never Done.
  if (has('sessionEnd')) {
    for (const before of [['promptSubmit'], ['promptSubmit', 'toolStart'], ['promptSubmit', 'permissionAsk'], []]) {
      const usable = before.filter(name => spec.fixtures[name] && spec.fixtures[name]('probe', 1));
      const h = fresh();
      const state = h.run('s1', ...usable, 'sessionEnd');
      assert.notStrictEqual(statusOf(state), STATUS.DONE, label(`session end after ${usable.join(',') || 'nothing'} -> Done`));
    }
  }

  // Subagents never settle their parent.
  for (const name of ['subagentActivity', 'subagentComplete', 'subagentFailure']) {
    if (has('promptSubmit', name)) {
      const status = fresh().run('s1', 'promptSubmit', name).status;
      assert.strictEqual(status, STATUS.COOKING, label(`${name} changes the running parent to ${status}`));
    }
  }

  // Sessions are isolated, whatever the interleaving.
  if (has('promptSubmit', 'turnComplete')) {
    const h = fresh();
    h.run('a', 'promptSubmit');
    h.run('b', 'promptSubmit');
    h.run('a', 'turnComplete');
    if (spec.fixtures.permissionAsk && spec.fixtures.permissionAsk('probe', 1)) h.run('b', 'permissionAsk');
    assert.strictEqual(h.status('a'), STATUS.DONE, label('session a'));
    assert.ok([STATUS.COOKING, STATUS.YOUR_TURN].includes(h.status('b')), label('session b is not affected by a'));
    assert.strictEqual(h.states.get('a').session_id, 'a', label('stable session identity'));
    assert.strictEqual(h.states.get('b').session_id, 'b', label('stable session identity'));
  }

  // Nothing sensitive is stored or logged: fixtures embed SECRET in prompts, tool inputs
  // and messages, which must never reach the session state or the console.
  {
    const writes = [];
    const originals = { log: console.log, error: console.error, warn: console.warn, write: process.stdout.write, ewrite: process.stderr.write };
    console.log = console.error = console.warn = (...args) => { writes.push(args.join(' ')); };
    process.stdout.write = process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    let h;
    try {
      h = fresh();
      for (const name of Object.keys(spec.fixtures)) h.run('s1', name);
    } finally {
      console.log = originals.log;
      console.error = originals.error;
      console.warn = originals.warn;
      process.stdout.write = originals.write;
      process.stderr.write = originals.ewrite;
    }
    assert.deepStrictEqual(writes, [], label('mapping events writes to the console'));
    const stored = JSON.stringify([...h.states.values()]);
    assert.ok(!stored.includes(SECRET), label('session state contains prompt, tool input or message content'));
  }

  // Hook adapters: every event is a separate process that only sees the state file, so
  // replaying through the file must give the same states as replaying in memory.
  if (spec.replayThroughFiles) {
    const sequences = [
      ['promptSubmit', 'toolStart', 'permissionAsk', ['toolStart', 2], 'permissionResolve', 'toolEnd', 'turnComplete'],
      ['promptSubmit', 'questionAsk', 'questionResolve', 'failure'],
      ['promptSubmit', 'subagentActivity', 'subagentComplete', 'cancel', 'promptSubmit', 'sessionEnd'],
    ];
    for (const names of sequences) {
      const h = fresh();
      const events = [];
      const expected = names.map((entry) => {
        const [name, n] = Array.isArray(entry) ? entry : [entry, 1];
        const event = h.fx(name, 's1', n);
        if (event) events.push(event);
        return event ? statusOf(h.apply('s1', event)) : undefined;
      }).filter(x => x !== undefined);
      const actual = spec.replayThroughFiles('s1', events);
      assert.deepStrictEqual(actual, expected, label(`file replay differs from memory: ${names.join(',')}`));
    }
  }

  // Not installed: availability is false and nothing throws.
  if (spec.createAdapter) {
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-conformance-home-'));
    try {
      process.env.PATH = '';
      process.env.HOME = home;
      for (const key of spec.binEnv || []) delete process.env[key];
      const adapter = spec.createAdapter();
      assert.strictEqual(adapter.id, spec.id, label('registry adapter id'));
      assert.strictEqual(adapter.isAvailable(), false, label('reported available without an installation'));
    } finally {
      process.env.PATH = saved.PATH;
      process.env.HOME = saved.HOME;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // Adapters never open network connections or start processes.
  for (const file of spec.sourceFiles || []) {
    const code = fs.readFileSync(file, 'utf8');
    for (const forbidden of ['node:http', 'node:https', 'node:net', 'node:dgram', 'node:child_process', 'fetch(']) {
      assert.ok(!code.includes(forbidden), label(`${file} uses ${forbidden}`));
    }
  }

  return { id: spec.id, notApplicable: [...new Set(notApplicable)] };
}

export default { runConformance, SECRET };
