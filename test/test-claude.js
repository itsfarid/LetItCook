import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claudeHooks, ClaudeAdapter } from '../src/adapters/claude/hooks.js';
import { createDefaultRegistry } from '../src/core/registry.js';
import { applySignals } from '../src/hooks/bridge.js';
import { SIGNAL } from '../src/core/lifecycle.js';
import { STATUS } from '../src/core/status.js';

const HOOK = path.resolve('src/hooks/hook.js');

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// Runs the real hook command like Claude Code does: one JSON event on stdin.
export function runHookCommand(agent, input, stateHome) {
  const result = spawnSync(process.execPath, [HOOK, agent], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { PATH: process.env.PATH, HOME: stateHome, XDG_STATE_HOME: stateHome },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(result.status, 0, `hook exits 0 (stderr: ${result.stderr})`);
  assert.strictEqual(result.stdout, '', 'hook prints nothing to stdout');
  assert.strictEqual(result.stderr, '', 'hook prints nothing to stderr');
  return result;
}

function testDetection() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-claude-bin-'));
  try {
    withEnv({ PATH: bin, CLAUDE_BIN: undefined }, () => {
      assert.strictEqual(new ClaudeAdapter().isAvailable(), false, 'not installed');
      fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
      assert.strictEqual(new ClaudeAdapter().isAvailable(), true, 'claude on PATH');
    });
    withEnv({ PATH: '', CLAUDE_BIN: '/opt/claude' }, () => {
      assert.strictEqual(new ClaudeAdapter().isAvailable(), true, 'CLAUDE_BIN override');
    });
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
  assert.ok(createDefaultRegistry().get('claude') instanceof ClaudeAdapter, 'registered in the default registry');
}

function testDetectSessionsReadsOnlyClaudeFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-claude-state-'));
  try {
    applySignals('claude', [{ type: SIGNAL.TURN_START, sessionId: 'c1' }], { stateDir: dir, pid: null });
    applySignals('gemini', [{ type: SIGNAL.TURN_START, sessionId: 'c1' }], { stateDir: dir, pid: null });
    const adapter = new ClaudeAdapter();
    const sessions = adapter.detectSessions({ baseDir: dir });
    assert.deepStrictEqual(sessions.map(s => [s.agent, s.session_id, s.status]), [['claude', 'c1', STATUS.COOKING]]);
    assert.strictEqual(adapter.getSessionState('c1', { baseDir: dir }).status, STATUS.COOKING);
    assert.strictEqual(adapter.getSessionState('../c1', { baseDir: dir }), null);
    assert.strictEqual(adapter.getSessionState('missing', { baseDir: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testHookCommandIsAPureObserver() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-claude-home-'));
  try {
    for (const input of ['', 'not json', '[]', JSON.stringify({ hook_event_name: 'Bogus', session_id: 's' })]) {
      runHookCommand('claude', input, home);
    }
    runHookCommand('no-such-agent', { session_id: 'x' }, home);
    runHookCommand('__proto__', { session_id: 'x' }, home);
    runHookCommand('claude', 'x'.repeat(17 * 1024 * 1024), home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testSkeletonIgnoresInput() {
  assert.strictEqual(claudeHooks.id, 'claude');
  assert.deepStrictEqual(claudeHooks.toSignals({}), []);
}

function run() {
  testDetection();
  testDetectSessionsReadsOnlyClaudeFiles();
  testHookCommandIsAPureObserver();
  testSkeletonIgnoresInput();
  console.log('All LetItCook Claude Code adapter tests passed.');
}

run();
