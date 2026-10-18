// Runs the shared adapter conformance suite (test/conformance/adapter-conformance.js)
// against every adapter with synthetic fixtures. No agent, network or model is used.

import { runConformance, SECRET } from './conformance/adapter-conformance.js';
import { STATUS } from '../src/core/status.js';
import { mapOpenCodeEvent, mapToolHook, OpenCodeAdapter } from '../src/adapters/opencode/adapter.js';
import { mapCopilotEvent, CopilotAdapter } from '../src/adapters/copilot/adapter.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reduceSession } from '../src/core/lifecycle.js';
import { applySignals, readStateFile, stateFileName } from '../src/hooks/bridge.js';
import { claudeHooks, ClaudeAdapter } from '../src/adapters/claude/hooks.js';

// Applies a fixture that may be a single event or a sequence of events.
function sequenced(stepOne) {
  return (prev, event, now) => {
    if (!Array.isArray(event)) return stepOne(prev, event, now);
    let state = prev;
    for (const item of event) {
      const next = stepOne(state, item, now);
      if (next) state = next;
    }
    return state === prev ? null : state;
  };
}

let counter = 0;
const unique = prefix => `${prefix}${++counter}`;

// --- OpenCode: plugin events and tool hooks (src/adapters/opencode) ---
const openCodeUsers = new Map();
export const openCodeSpec = {
  id: 'opencode',
  step: sequenced((prev, event) => {
    if (event && typeof event === 'object' && typeof event.hook === 'string') {
      return mapToolHook(event.hook, event.input, prev);
    }
    return mapOpenCodeEvent(event, prev);
  }),
  fixtures: {
    promptSubmit: (sid) => {
      const id = unique('msg_user');
      openCodeUsers.set(sid, id);
      return { type: 'message.updated', properties: { info: { id, sessionID: sid, role: 'user', summary: { title: SECRET } } } };
    },
    toolStart: (sid, n) => ({ hook: 'before', input: { tool: 'bash', sessionID: sid, callID: `call_${n}`, args: { command: SECRET } } }),
    toolEnd: (sid, n) => ({ hook: 'after', input: { tool: 'bash', sessionID: sid, callID: `call_${n}` } }),
    permissionAsk: (sid, n) => ({ type: 'permission.asked', properties: { id: `per_${n}`, sessionID: sid, permission: 'bash', patterns: ['npm test'] } }),
    permissionResolve: (sid, n) => ({ type: 'permission.replied', properties: { sessionID: sid, requestID: `per_${n}`, reply: 'once' } }),
    questionAsk: (sid, n) => ({ type: 'question.asked', properties: { id: `que_${n}`, sessionID: sid, questions: [{ question: SECRET }] } }),
    questionResolve: (sid, n) => ({ type: 'question.replied', properties: { sessionID: sid, requestID: `que_${n}`, answers: [[SECRET]] } }),
    turnComplete: (sid) => [
      { type: 'message.updated', properties: { info: {
        id: unique('msg_assistant'), sessionID: sid, role: 'assistant', parentID: openCodeUsers.get(sid),
        finish: 'stop', time: { completed: Date.now() },
      } } },
      { type: 'session.idle', properties: { sessionID: sid } },
    ],
    turnEndUnknown: sid => ({ type: 'session.idle', properties: { sessionID: sid } }),
    failure: sid => ({ type: 'session.error', properties: { sessionID: sid, error: { name: 'APIError', data: { message: 'rate limited' } } } }),
    // Project decision: cancelling a prompt (Esc) is Burn in OpenCode (README, Known limitations).
    cancel: sid => ({ type: 'session.error', properties: { sessionID: sid, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } } }),
    sessionEnd: sid => ({ type: 'session.deleted', properties: { info: { id: sid } } }),
    // Subagents are separate OpenCode sessions (covered by session isolation), so no
    // subagent event ever reaches the parent session.
    subagentActivity: () => null,
    subagentComplete: () => null,
    subagentFailure: () => null,
  },
  malformed: [{ type: 42 }, { type: '' }, { type: 'message.updated', properties: null }, { type: 'totally.unknown', properties: { sessionID: 's1' } }],
  expect: { cancel: STATUS.BURN },
  notes: {
    lateToolEvent: 'tool hooks run inline in the agent loop, so one after Done is new work, not a late event',
  },
  createAdapter: () => new OpenCodeAdapter(),
  binEnv: ['OPENCODE_BIN'],
  sourceFiles: ['src/adapters/opencode/adapter.js', 'src/adapters/opencode/plugin.js'],
};

// --- GitHub Copilot CLI: replayed events.jsonl (src/adapters/copilot) ---
const copilotEvent = (type, sid, data = {}) => ({ type, data: { sessionId: sid, ...data }, timestamp: new Date().toISOString() });
export const copilotSpec = {
  id: 'copilot',
  step: sequenced((prev, event) => mapCopilotEvent(event, prev)),
  fixtures: {
    promptSubmit: sid => [copilotEvent('user.message', sid, { content: SECRET }), copilotEvent('assistant.turn_start', sid)],
    toolStart: (sid, n) => copilotEvent('tool.execution_start', sid, { toolCallId: `t${n}`, toolName: 'bash', arguments: { command: SECRET } }),
    toolEnd: (sid, n) => copilotEvent('tool.execution_complete', sid, { toolCallId: `t${n}`, toolName: 'bash' }),
    permissionAsk: (sid, n) => copilotEvent('permission.requested', sid, { requestId: `p${n}`, permissionRequest: { kind: 'shell', fullCommandText: SECRET } }),
    permissionResolve: (sid, n) => copilotEvent('permission.completed', sid, { requestId: `p${n}`, result: { kind: 'approved' } }),
    questionAsk: (sid, n) => copilotEvent('user_input.requested', sid, { requestId: `q${n}`, question: 'Which option?' }),
    questionResolve: (sid, n) => copilotEvent('user_input.completed', sid, { requestId: `q${n}` }),
    turnComplete: sid => copilotEvent('session.task_complete', sid, { success: true, summary: 'ok' }),
    // Copilot's documented end of turn: the agent waits for the next input.
    turnEndUnknown: sid => copilotEvent('assistant.turn_end', sid),
    failure: sid => copilotEvent('session.error', sid, { errorType: 'rate_limit', message: 'rate limited' }),
    cancel: sid => copilotEvent('abort', sid, { reason: 'user initiated' }),
    sessionEnd: sid => copilotEvent('session.shutdown', sid, { shutdownType: 'routine' }),
    subagentActivity: sid => copilotEvent('subagent.started', sid, { toolCallId: 'sub1', agentName: 'explore' }),
    subagentComplete: sid => copilotEvent('subagent.completed', sid, { toolCallId: 'sub1', agentName: 'explore' }),
    subagentFailure: () => null,
  },
  malformed: [{ type: 'assistant.turn_start', data: null }, { type: 7 }, { type: 'totally.unknown', data: { sessionId: 's1' } }],
  expect: { cancel: STATUS.YOUR_TURN },
  notes: {
    lateToolEvent: 'events are replayed from an append-only log in order, so a tool event after task_complete was recorded later',
  },
  createAdapter: () => new CopilotAdapter(),
  binEnv: ['COPILOT_BIN', 'LETITCOOK_COPILOT_DIR'],
  sourceFiles: ['src/adapters/copilot/adapter.js'],
};

// --- Hook adapters (src/hooks/bridge.js + the shared lifecycle reducer) ---
function hookStep(hooks) {
  return sequenced((prev, input, now) => {
    let state = prev;
    for (const signal of hooks.toSignals(input)) {
      const next = reduceSession(state && !state.deleted ? state : null, signal, { agent: hooks.id, now });
      if (next) state = next;
    }
    return state === prev ? null : state;
  });
}

function hookReplayThroughFiles(hooks) {
  return (sid, events) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `letitcook-conformance-${hooks.id}-`));
    try {
      return events.map((event) => {
        for (const input of Array.isArray(event) ? event : [event]) {
          applySignals(hooks.id, hooks.toSignals(input), { stateDir: dir, pid: null });
        }
        const file = path.join(dir, stateFileName(hooks.id, sid));
        if (!fs.existsSync(file)) return 'removed';
        return readStateFile(file, { sessionId: sid, agent: hooks.id }).status;
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// --- Claude Code: command hooks (src/adapters/claude/hooks.js) ---
const claudeEvent = (event, sid, extra = {}) => ({
  session_id: sid, prompt_id: 'p', transcript_path: '/t.jsonl', cwd: '/work', permission_mode: 'default',
  hook_event_name: event, ...extra,
});
export const claudeSpec = {
  id: 'claude',
  step: hookStep(claudeHooks),
  replayThroughFiles: hookReplayThroughFiles(claudeHooks),
  fixtures: {
    promptSubmit: sid => claudeEvent('UserPromptSubmit', sid, { prompt: SECRET }),
    toolStart: (sid, n) => claudeEvent('PreToolUse', sid, { tool_name: 'Bash', tool_use_id: `toolu_${n}`, tool_input: { command: `${SECRET} ${n}` } }),
    toolEnd: (sid, n) => claudeEvent('PostToolUse', sid, { tool_name: 'Bash', tool_use_id: `toolu_${n}`, tool_input: { command: `${SECRET} ${n}` }, tool_response: { stdout: SECRET } }),
    permissionAsk: (sid, n) => claudeEvent('PermissionRequest', sid, { tool_name: 'Write', tool_input: { file_path: `/w/${n}`, content: SECRET } }),
    permissionResolve: (sid, n) => claudeEvent('PostToolUse', sid, { tool_name: 'Write', tool_use_id: `toolu_w${n}`, tool_input: { file_path: `/w/${n}`, content: SECRET }, tool_response: {} }),
    questionAsk: (sid, n) => claudeEvent('PreToolUse', sid, { tool_name: 'AskUserQuestion', tool_use_id: `toolu_q${n}`, tool_input: { questions: [{ question: SECRET }] } }),
    questionResolve: (sid, n) => claudeEvent('PostToolUse', sid, { tool_name: 'AskUserQuestion', tool_use_id: `toolu_q${n}`, tool_input: { questions: [{ question: SECRET }] }, tool_response: { answers: { a: SECRET } } }),
  },
  malformed: [{ hook_event_name: 'PreToolUse' }, { hook_event_name: 'Stop', session_id: '../x' }, { hook_event_name: ['Stop'], session_id: 's1' }],
  createAdapter: () => new ClaudeAdapter(),
  binEnv: ['CLAUDE_BIN'],
  sourceFiles: ['src/adapters/claude/hooks.js', 'src/adapters/hook-adapter.js', 'src/core/lifecycle.js'],
};

export const SPECS = [openCodeSpec, copilotSpec, claudeSpec];

function run() {
  for (const spec of SPECS) {
    const { id, notApplicable } = runConformance(spec);
    console.log(`  ${id}: conformance passed${notApplicable.length ? `; not applicable: ${notApplicable.join('; ')}` : ''}`);
  }
  console.log('All LetItCook adapter conformance tests passed.');
}

run();
