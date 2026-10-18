import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { geminiHooks, GeminiAdapter } from '../src/adapters/gemini/hooks.js';
import { createDefaultRegistry } from '../src/core/registry.js';
import { applySignals } from '../src/hooks/bridge.js';
import { STATUS } from '../src/core/status.js';

const HOOK = path.resolve('src/hooks/hook.js');

// A Gemini CLI hook input as documented (common fields plus event-specific ones).
export function geminiEvent(event, sessionId, extra = {}) {
  return {
    session_id: sessionId,
    transcript_path: '',
    cwd: '/work/project',
    hook_event_name: event,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function replay(inputs, dir) {
  for (const input of inputs) applySignals('gemini', geminiHooks.toSignals(input), { stateDir: dir, pid: 4242 });
}

function withState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-gemini-'));
  try {
    return fn(dir, sid => new GeminiAdapter().getSessionState(sid, { baseDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testDetectionAndRegistration() {
  const saved = { PATH: process.env.PATH, GEMINI_BIN: process.env.GEMINI_BIN };
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-gemini-bin-'));
  try {
    process.env.PATH = bin;
    delete process.env.GEMINI_BIN;
    assert.strictEqual(new GeminiAdapter().isAvailable(), false);
    fs.writeFileSync(path.join(bin, 'gemini'), '#!/bin/sh\n', { mode: 0o755 });
    assert.strictEqual(new GeminiAdapter().isAvailable(), true);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.GEMINI_BIN === undefined) delete process.env.GEMINI_BIN; else process.env.GEMINI_BIN = saved.GEMINI_BIN;
    fs.rmSync(bin, { recursive: true, force: true });
  }
  assert.ok(createDefaultRegistry().get('gemini') instanceof GeminiAdapter);
  for (const input of [null, {}, { hook_event_name: [] }, geminiEvent('AfterModel', 's', { llm_response: {} })]) {
    assert.deepStrictEqual(geminiHooks.toSignals(input), []);
  }
}

function testActivity() {
  withState((dir, state) => {
    const secret = 'SECRET-GEMINI-PROMPT';
    replay([
      geminiEvent('BeforeAgent', 'g-1', { prompt: secret }),
      geminiEvent('BeforeTool', 'g-1', { tool_name: 'run_shell_command', tool_input: { command: secret } }),
      geminiEvent('AfterTool', 'g-1', { tool_name: 'run_shell_command', tool_input: { command: secret }, tool_response: { llmContent: secret } }),
    ], dir);
    assert.strictEqual(state('g-1').status, STATUS.COOKING);
    assert.strictEqual(state('g-1').reason, 'tool:run_shell_command');
    assert.strictEqual(state('g-1').cwd, '/work/project');
    assert.ok(!fs.readFileSync(path.join(dir, 'gemini_g-1.json'), 'utf8').includes(secret), 'no prompt or tool content is stored');
  });
}

function testHookCommandAndConfig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-gemini-home-'));
  try {
    const config = JSON.parse(spawnSync(process.execPath, [HOOK, '--print-config', 'gemini'], { encoding: 'utf8' }).stdout);
    assert.deepStrictEqual(Object.keys(config.hooks), geminiHooks.events);
    for (const groups of Object.values(config.hooks)) {
      const [hook] = groups[0].hooks;
      assert.strictEqual(hook.type, 'command');
      assert.strictEqual(hook.timeout, 10000, 'Gemini timeouts are in milliseconds');
      assert.match(hook.name, /^letitcook-/, 'named, so it can be disabled');
    }
    // Gemini runs hooks with `bash -c <command>`.
    const run = spawnSync('bash', ['-c', config.hooks.BeforeAgent[0].hooks[0].command], {
      input: JSON.stringify(geminiEvent('BeforeAgent', 'g-e2e', { prompt: 'x' })),
      env: { PATH: '/usr/bin:/bin', HOME: home, XDG_STATE_HOME: home },
      encoding: 'utf8',
    });
    assert.strictEqual(run.status, 0);
    assert.strictEqual(run.stdout + run.stderr, '', 'empty stdout and stderr: Gemini then applies no output');
    const file = path.join(home, 'letitcook', 'sessions', 'gemini_g-e2e.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).status, STATUS.COOKING);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function run() {
  testDetectionAndRegistration();
  testActivity();
  testHookCommandAndConfig();
  console.log('All LetItCook Gemini CLI adapter tests passed.');
}

run();
