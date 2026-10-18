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

// A Claude Code hook input as documented: common fields plus event-specific ones.
export function claudeEvent(event, sessionId, extra = {}) {
  return {
    session_id: sessionId,
    prompt_id: 'p1',
    transcript_path: `/home/u/.claude/projects/x/${sessionId}.jsonl`,
    cwd: '/work/project',
    permission_mode: 'default',
    hook_event_name: event,
    ...extra,
  };
}

// Reduces a sequence of hook inputs through the adapter and the shared contract.
export function replay(inputs, dir) {
  for (const input of inputs) applySignals('claude', claudeHooks.toSignals(input), { stateDir: dir, pid: 4242 });
  return new ClaudeAdapter();
}

function testIgnoresMalformedInput() {
  for (const input of [null, {}, { hook_event_name: 7, session_id: 's' }, { hook_event_name: 'Unknown', session_id: 's' }, 'x']) {
    assert.deepStrictEqual(claudeHooks.toSignals(input), [], `ignores ${JSON.stringify(input)}`);
  }
}

function testActivityAndIdentity() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-claude-activity-'));
  try {
    const secret = 'sk-ant-SECRET-PROMPT-TEXT';
    const adapter = replay([
      claudeEvent('UserPromptSubmit', 'sess-a', { prompt: secret, session_title: 'Fix the login bug' }),
      claudeEvent('PreToolUse', 'sess-a', { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: secret } }),
    ], dir);
    let state = adapter.getSessionState('sess-a', { baseDir: dir });
    assert.strictEqual(state.status, STATUS.COOKING);
    assert.strictEqual(state.reason, 'tool:Bash');
    assert.strictEqual(state.cwd, '/work/project');
    assert.strictEqual(state.title, 'Fix the login bug');
    assert.strictEqual(state.pid, 4242);
    replay([claudeEvent('PostToolUse', 'sess-a', { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_response: { stdout: secret } })], dir);
    state = adapter.getSessionState('sess-a', { baseDir: dir });
    assert.strictEqual(state.status, STATUS.COOKING);
    assert.ok(!fs.readFileSync(path.join(dir, 'claude_sess-a.json'), 'utf8').includes(secret), 'no prompt or tool content is stored');

    replay([claudeEvent('PostToolUseFailure', 'sess-a', { tool_name: 'mcp__srv__do it;rm', tool_use_id: 'toolu_2', error: 'boom' })], dir);
    assert.strictEqual(adapter.getSessionState('sess-a', { baseDir: dir }).reason, 'tool:mcp__srv__doitrm', 'tool names are reduced to identifiers');
    assert.strictEqual(adapter.getSessionState('sess-a', { baseDir: dir }).status, STATUS.COOKING, 'a failing tool is not Burn');

    replay([claudeEvent('UserPromptSubmit', 'sess-b', {})], dir);
    assert.deepStrictEqual(adapter.detectSessions({ baseDir: dir }).map(x => x.session_id).sort(), ['sess-a', 'sess-b'], 'sessions are separate');
    replay([claudeEvent('PreToolUse', '../escape', { tool_name: 'Bash' })], dir);
    assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'claude_..')), 'unsafe session ids are ignored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testPermissionsAndQuestions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-claude-perm-'));
  const status = sid => new ClaudeAdapter().getSessionState(sid, { baseDir: dir });
  try {
    const bash = { tool_name: 'Bash', tool_input: { command: 'npm test' } };
    replay([
      claudeEvent('UserPromptSubmit', 'p1'),
      claudeEvent('PreToolUse', 'p1', { ...bash, tool_use_id: 'toolu_1' }),
      claudeEvent('PermissionRequest', 'p1', bash),
    ], dir);
    assert.strictEqual(status('p1').status, STATUS.YOUR_TURN);
    assert.strictEqual(status('p1').reason, 'permission:Bash', 'the reason names the tool, never the command');

    // Other work (e.g. a parallel subagent) does not hide the waiting permission.
    replay([
      claudeEvent('PreToolUse', 'p1', { tool_name: 'Read', tool_use_id: 'toolu_9', tool_input: { file_path: '/x' }, agent_id: 'agent-1' }),
      claudeEvent('PostToolUse', 'p1', { tool_name: 'Read', tool_use_id: 'toolu_9', tool_input: { file_path: '/x' }, agent_id: 'agent-1' }),
    ], dir);
    assert.strictEqual(status('p1').status, STATUS.YOUR_TURN, 'unrelated activity keeps Your Turn');

    // Approved: the tool runs and its PostToolUse resolves the request.
    replay([claudeEvent('PostToolUse', 'p1', { ...bash, tool_use_id: 'toolu_1', tool_response: {} })], dir);
    assert.strictEqual(status('p1').status, STATUS.COOKING);

    // The identical command asking again is shown again.
    replay([claudeEvent('PreToolUse', 'p1', { ...bash, tool_use_id: 'toolu_2' }), claudeEvent('PermissionRequest', 'p1', bash)], dir);
    assert.strictEqual(status('p1').status, STATUS.YOUR_TURN, 'an identical later request is not suppressed');
    replay([claudeEvent('PostToolUseFailure', 'p1', { ...bash, tool_use_id: 'toolu_2', error: 'exit 1' })], dir);
    assert.strictEqual(status('p1').status, STATUS.COOKING, 'a failing approved tool resolves its request too');

    // Denied in auto mode.
    replay([claudeEvent('PermissionRequest', 'p1', bash), claudeEvent('PermissionDenied', 'p1', { ...bash, tool_use_id: 'toolu_3' })], dir);
    assert.strictEqual(status('p1').status, STATUS.COOKING);

    // Denied by the user ("No, tell Claude what to do differently"): the turn stops and the
    // request stays shown until the user's next prompt.
    replay([claudeEvent('PermissionRequest', 'p1', bash)], dir);
    assert.strictEqual(status('p1').status, STATUS.YOUR_TURN);
    replay([claudeEvent('UserPromptSubmit', 'p1')], dir);
    assert.strictEqual(status('p1').status, STATUS.COOKING, 'the next prompt clears it');

    // AskUserQuestion: Your Turn while the question is shown.
    const ask = { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q', tool_input: { questions: [{ question: 'secret?' }] } };
    replay([claudeEvent('PreToolUse', 'p1', ask)], dir);
    assert.strictEqual(status('p1').status, STATUS.YOUR_TURN);
    assert.strictEqual(status('p1').reason, 'question');
    replay([claudeEvent('PostToolUse', 'p1', { ...ask, tool_response: { answers: {} } })], dir);
    assert.strictEqual(status('p1').status, STATUS.COOKING);

    // MCP elicitation.
    replay([claudeEvent('Elicitation', 'p1', { mcp_server_name: 'github', elicitation_id: 'e1', message: 'secret' })], dir);
    assert.strictEqual(status('p1').status, STATUS.YOUR_TURN);
    assert.strictEqual(status('p1').reason, 'elicitation:github');
    replay([claudeEvent('ElicitationResult', 'p1', { mcp_server_name: 'github', elicitation_id: 'e1', action: 'accept' })], dir);
    assert.strictEqual(status('p1').status, STATUS.COOKING);

    // Long names never truncate the request id's digest.
    const long = { tool_name: 'mcp__' + 'x'.repeat(200), agent_id: 'a'.repeat(200) };
    const ids = [{ q: 1 }, { q: 2 }].map(tool_input => claudeHooks.toSignals(claudeEvent('PermissionRequest', 's', { ...long, tool_input }))[0].requestId);
    assert.notStrictEqual(ids[0], ids[1]);
    assert.ok(ids.every(id => id.length <= 128));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testTurnEndings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-claude-end-'));
  const state = sid => new ClaudeAdapter().getSessionState(sid, { baseDir: dir });
  const file = sid => path.join(dir, `claude_${sid}.json`);
  try {
    replay([claudeEvent('UserPromptSubmit', 'e1'), claudeEvent('Stop', 'e1', { stop_hook_active: false, last_assistant_message: 'secret' })], dir);
    assert.strictEqual(state('e1').status, STATUS.DONE, 'Stop -> Done');
    replay([claudeEvent('Stop', 'e1'), claudeEvent('PostToolUse', 'e1', { tool_name: 'Bash', tool_use_id: 't', agent_id: 'bg' })], dir);
    assert.strictEqual(state('e1').status, STATUS.DONE, 'duplicate Stop and late subagent activity keep Done');
    // Another Stop hook blocked the stop: Claude continues the turn with a new tool call.
    replay([claudeEvent('PreToolUse', 'e1', { tool_name: 'Bash', tool_use_id: 't2' })], dir);
    assert.strictEqual(state('e1').status, STATUS.COOKING, 'the main agent continuing leaves Done');
    replay([claudeEvent('Stop', 'e1', { stop_hook_active: true })], dir);
    assert.strictEqual(state('e1').status, STATUS.DONE);

    replay([claudeEvent('UserPromptSubmit', 'e2'), claudeEvent('StopFailure', 'e2', { error: 'rate_limit', error_details: 'secret details' })], dir);
    assert.strictEqual(state('e2').status, STATUS.BURN, 'StopFailure -> Burn');
    assert.strictEqual(state('e2').reason, 'error:rate_limit');
    replay([claudeEvent('StopFailure', 'e2', { error: 'over; rm -rf /' })], dir);
    assert.strictEqual(state('e2').reason, 'error:overrm-rf', 'error codes are reduced to identifiers');

    // Esc while a tool runs: the tool fails with is_interrupt and Stop does not fire.
    replay([
      claudeEvent('UserPromptSubmit', 'e3'),
      claudeEvent('PreToolUse', 'e3', { tool_name: 'Bash', tool_use_id: 't' }),
      claudeEvent('PostToolUseFailure', 'e3', { tool_name: 'Bash', tool_use_id: 't', error: 'interrupted', is_interrupt: true }),
    ], dir);
    assert.strictEqual(state('e3').status, STATUS.YOUR_TURN, 'an interrupt hands the turn back, it is not Burn');
    assert.strictEqual(state('e3').reason, 'interrupted');

    // A session ending never claims Done, whatever it was doing.
    for (const before of [[], [claudeEvent('PreToolUse', 'e4', { tool_name: 'Bash' })], [claudeEvent('PermissionRequest', 'e4', { tool_name: 'Bash' })]]) {
      replay([claudeEvent('UserPromptSubmit', 'e4'), ...before, claudeEvent('SessionEnd', 'e4', { reason: 'prompt_input_exit' })], dir);
      assert.ok(!fs.existsSync(file('e4')), 'SessionEnd removes the session');
    }
    replay([claudeEvent('SessionEnd', 'never-started', { reason: 'other' })], dir);
    assert.ok(!fs.existsSync(file('never-started')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testSubagents() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-claude-sub-'));
  const state = sid => new ClaudeAdapter().getSessionState(sid, { baseDir: dir });
  const sub = { agent_id: 'agent-7', agent_type: 'Explore' };
  try {
    replay([
      claudeEvent('UserPromptSubmit', 'm1'),
      claudeEvent('PreToolUse', 'm1', { tool_name: 'Task', tool_use_id: 'toolu_task' }),
      claudeEvent('SubagentStart', 'm1', sub),
      claudeEvent('PreToolUse', 'm1', { ...sub, tool_name: 'Grep', tool_use_id: 'toolu_s1' }),
      claudeEvent('PostToolUseFailure', 'm1', { ...sub, tool_name: 'Grep', tool_use_id: 'toolu_s1', is_interrupt: true }),
      claudeEvent('SubagentStop', 'm1', { ...sub, agent_transcript_path: '/t', last_assistant_message: 'done' }),
    ], dir);
    assert.strictEqual(state('m1').status, STATUS.COOKING, 'a subagent finishing leaves the running parent Cooking');
    assert.strictEqual(state('m1').reason, 'subagent:Explore');

    // A subagent's permission request is the user's turn too, and is told apart from an
    // identical request of the main agent.
    const grep = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    replay([claudeEvent('PermissionRequest', 'm1', { ...sub, ...grep }), claudeEvent('PermissionRequest', 'm1', grep)], dir);
    assert.strictEqual(state('m1').status, STATUS.YOUR_TURN);
    replay([claudeEvent('PostToolUse', 'm1', { ...sub, ...grep, tool_use_id: 'a' })], dir);
    assert.strictEqual(state('m1').status, STATUS.YOUR_TURN, "the main agent's request is still waiting");
    replay([claudeEvent('PostToolUse', 'm1', { ...grep, tool_use_id: 'b' })], dir);
    assert.strictEqual(state('m1').status, STATUS.COOKING);

    replay([claudeEvent('Stop', 'm1')], dir);
    assert.strictEqual(state('m1').status, STATUS.DONE);
    replay([claudeEvent('PreToolUse', 'm1', { ...sub, tool_name: 'Read', tool_use_id: 'late' }), claudeEvent('SubagentStop', 'm1', sub)], dir);
    assert.strictEqual(state('m1').status, STATUS.DONE, 'a background subagent working after Stop does not revive the parent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testHookCommandEndToEnd() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-claude-e2e-'));
  try {
    runHookCommand('claude', claudeEvent('UserPromptSubmit', 'sess-e2e', { prompt: 'hi' }), home);
    const file = path.join(home, 'letitcook', 'sessions', 'claude_sess-e2e.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(state.status, STATUS.COOKING);
    assert.strictEqual(state.agent, 'claude');
    assert.strictEqual(state.pid, process.pid, 'the pid is the process that ran the hook');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function run() {
  testDetection();
  testDetectSessionsReadsOnlyClaudeFiles();
  testHookCommandIsAPureObserver();
  testIgnoresMalformedInput();
  testActivityAndIdentity();
  testPermissionsAndQuestions();
  testTurnEndings();
  testSubagents();
  testHookCommandEndToEnd();
  console.log('All LetItCook Claude Code adapter tests passed.');
}

run();
