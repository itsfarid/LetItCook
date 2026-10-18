import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codexHooks, CodexAdapter } from '../src/adapters/codex/hooks.js';
import { createDefaultRegistry } from '../src/core/registry.js';
import { applySignals } from '../src/hooks/bridge.js';
import { STATUS } from '../src/core/status.js';

const HOOK = path.resolve('src/hooks/hook.js');

// A Codex hook input as in codex-rs/hooks/schema/generated/*.command.input.schema.json.
export function codexEvent(event, sessionId, extra = {}) {
  return {
    session_id: sessionId,
    turn_id: 'turn-1',
    transcript_path: null,
    cwd: '/work/project',
    model: 'gpt-x',
    permission_mode: 'default',
    hook_event_name: event,
    ...extra,
  };
}

function replay(inputs, dir) {
  for (const input of inputs) applySignals('codex', codexHooks.toSignals(input), { stateDir: dir, pid: 4242 });
}

function withState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-codex-'));
  try {
    return fn(dir, sid => new CodexAdapter().getSessionState(sid, { baseDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testDetectionAndRegistration() {
  const saved = { PATH: process.env.PATH, CODEX_BIN: process.env.CODEX_BIN };
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-codex-bin-'));
  try {
    process.env.PATH = bin;
    delete process.env.CODEX_BIN;
    assert.strictEqual(new CodexAdapter().isAvailable(), false);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    assert.strictEqual(new CodexAdapter().isAvailable(), true);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.CODEX_BIN === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = saved.CODEX_BIN;
    fs.rmSync(bin, { recursive: true, force: true });
  }
  assert.ok(createDefaultRegistry().get('codex') instanceof CodexAdapter);
  for (const input of [null, {}, { hook_event_name: 1 }, codexEvent('Unknown', 's')]) {
    assert.deepStrictEqual(codexHooks.toSignals(input), []);
  }
}

function testActivity() {
  withState((dir, state) => {
    const secret = 'sk-SECRET-CODEX-PROMPT';
    replay([
      codexEvent('UserPromptSubmit', 'th-1', { prompt: secret }),
      codexEvent('PreToolUse', 'th-1', { tool_name: 'exec_command', tool_use_id: 'call_1', tool_input: { cmd: secret } }),
    ], dir);
    assert.strictEqual(state('th-1').status, STATUS.COOKING);
    assert.strictEqual(state('th-1').reason, 'tool:exec_command');
    assert.strictEqual(state('th-1').cwd, '/work/project');
    replay([codexEvent('PostToolUse', 'th-1', { tool_name: 'exec_command', tool_use_id: 'call_1', tool_response: secret })], dir);
    assert.strictEqual(state('th-1').status, STATUS.COOKING);
    assert.ok(!fs.readFileSync(path.join(dir, 'codex_th-1.json'), 'utf8').includes(secret), 'no prompt or tool content is stored');
  });
}

function testHookCommandAndConfig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-codex-home-'));
  try {
    const run = spawnSync(process.execPath, [HOOK, 'codex'], {
      input: JSON.stringify(codexEvent('UserPromptSubmit', 'th-e2e', { prompt: 'x' })),
      env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: home },
      encoding: 'utf8',
    });
    assert.strictEqual(run.status, 0);
    assert.strictEqual(run.stdout + run.stderr, '', 'prints nothing (Stop and Interrupt hooks must output JSON or nothing)');
    const file = path.join(home, 'letitcook', 'sessions', 'codex_th-e2e.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).status, STATUS.COOKING);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  const printed = spawnSync(process.execPath, [HOOK, '--print-config', 'codex'], { encoding: 'utf8' });
  assert.strictEqual(printed.status, 0);
  const config = JSON.parse(printed.stdout);
  assert.deepStrictEqual(Object.keys(config), ['hooks'], 'hooks.json only allows description and hooks');
  assert.deepStrictEqual(Object.keys(config.hooks), codexHooks.events);
  for (const groups of Object.values(config.hooks)) {
    const [hook] = groups[0].hooks;
    assert.strictEqual(hook.type, 'command');
    assert.ok(Number.isInteger(hook.timeout) && hook.timeout >= 1 && hook.timeout <= 3, 'timeout in seconds, within the SessionEnd/Interrupt maximum');
  }
}

function run() {
  testDetectionAndRegistration();
  testActivity();
  testHookCommandAndConfig();
  console.log('All LetItCook Codex CLI adapter tests passed.');
}

run();
