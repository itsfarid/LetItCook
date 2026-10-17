import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATUS, aggregateState } from '../src/core/status.js';
import { NotificationTracker } from '../src/core/notification.js';
import {
  mapOpenCodeEvent,
  mapToolHook,
  writeSessionFile,
  deleteSessionFile,
  readAllSessionsFromDir,
} from '../src/adapters/opencode/adapter.js';

async function testFullOpenCodeLifecycle() {
  const testDir = path.join(os.tmpdir(), `letitcook_e2e_${Date.now()}`);

  try {
    let state = null;

    // Step 1: session.created
    state = mapOpenCodeEvent({
      type: 'session.created',
      properties: { sessionID: 'e2e_ses_1', directory: '/home/user/app', title: 'Feature App' },
      pid: process.pid,
    }, state);
    writeSessionFile(state, testDir);

    let current = readAllSessionsFromDir(testDir);
    let agg = aggregateState(current);
    assert.strictEqual(agg.status, STATUS.COOKING, 'Step 1 should be Cooking');
    assert.strictEqual(agg.sessionCount, 1);

    // Step 2: tool execution (bash)
    state = mapToolHook('before', { sessionID: 'e2e_ses_1', tool: 'bash' }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(aggregateState(current).status, STATUS.COOKING, 'Step 2 should be Cooking');

    // Step 3: permission.asked -> Your Turn
    state = mapOpenCodeEvent({
      type: 'permission.asked',
      properties: { sessionID: 'e2e_ses_1', permission: 'bash:exec', patterns: ['rm -rf /tmp/cache'] },
    }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(aggregateState(current).status, STATUS.YOUR_TURN, 'Step 3 should be Your Turn');

    // Step 4: permission.replied -> Cooking
    state = mapOpenCodeEvent({
      type: 'permission.replied',
      properties: { sessionID: 'e2e_ses_1', reply: 'approved' },
    }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(aggregateState(current).status, STATUS.COOKING, 'Step 4 should return to Cooking');

    // Step 5: question.asked -> Your Turn
    state = mapOpenCodeEvent({
      type: 'question.asked',
      properties: { sessionID: 'e2e_ses_1', question: 'Which framework?' },
    }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(aggregateState(current).status, STATUS.YOUR_TURN, 'Step 5 should be Your Turn');

    // Step 6: question.replied -> Cooking
    state = mapOpenCodeEvent({
      type: 'question.replied',
      properties: { sessionID: 'e2e_ses_1', reply: 'express' },
    }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(aggregateState(current).status, STATUS.COOKING, 'Step 6 should be Cooking');

    // Step 7: session.idle does not prove successful completion
    state = mapOpenCodeEvent({
      type: 'session.idle',
      properties: { sessionID: 'e2e_ses_1' },
    }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(aggregateState(current).status, STATUS.UNKNOWN, 'Step 7 idle state should remain Unknown');

    // Step 8: Multi-session concurrency test
    // Add second session in cooking
    let state2 = mapOpenCodeEvent({
      type: 'session.created',
      properties: { sessionID: 'e2e_ses_2', directory: '/home/user/backend', title: 'API server' },
      pid: process.pid,
    });
    writeSessionFile(state2, testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(current.length, 2);
    // Session 1 Done + Session 2 Cooking => Cooking
    assert.strictEqual(aggregateState(current).status, STATUS.COOKING, 'Done + Cooking should aggregate to Cooking');

    // Second session asks permission -> Your Turn
    state2 = mapOpenCodeEvent({
      type: 'permission.asked',
      properties: { sessionID: 'e2e_ses_2', permission: 'write_file' },
    }, state2);
    writeSessionFile(state2, testDir);
    current = readAllSessionsFromDir(testDir);
    // Session 1 Done + Session 2 Your Turn => Your Turn
    assert.strictEqual(aggregateState(current).status, STATUS.YOUR_TURN, 'Done + Your Turn should aggregate to Your Turn');

    // First session errors -> Burn
    state = mapOpenCodeEvent({
      type: 'session.error',
      properties: { sessionID: 'e2e_ses_1', error: { message: 'Connection reset' } },
    }, state);
    writeSessionFile(state, testDir);
    current = readAllSessionsFromDir(testDir);
    // Session 1 Burn + Session 2 Your Turn => Burn (Burn is highest priority)
    assert.strictEqual(aggregateState(current).status, STATUS.BURN, 'Burn + Your Turn should aggregate to Burn');

    // Delete session 1
    const del1 = mapOpenCodeEvent({
      type: 'session.deleted',
      properties: { sessionID: 'e2e_ses_1' },
    }, state);
    assert.strictEqual(del1.deleted, true);
    deleteSessionFile('e2e_ses_1', testDir);

    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(current.length, 1);
    assert.strictEqual(aggregateState(current).status, STATUS.YOUR_TURN, 'Remaining session is Your Turn');

    // Delete session 2
    deleteSessionFile('e2e_ses_2', testDir);
    current = readAllSessionsFromDir(testDir);
    assert.strictEqual(current.length, 0);
    assert.strictEqual(aggregateState(current).status, STATUS.UNKNOWN, 'No sessions aggregates to Unknown');

    // Stale handling test:
    const staleSession = {
      session_id: 'e2e_stale',
      agent: 'opencode',
      status: STATUS.COOKING,
      reason: 'hung task',
      title: 'Hung',
      cwd: '/tmp',
      pid: 999999,
      updated_at: Date.now() - 400000,
    };
    writeSessionFile(staleSession, testDir);
    current = readAllSessionsFromDir(testDir, { staleMs: 300000, isPidAlive: (pid) => pid === process.pid });
    assert.strictEqual(current[0].status, STATUS.UNKNOWN, 'Hung session with dead PID/old timestamp becomes Unknown');
    assert.strictEqual(aggregateState(current, { staleMs: 300000, isPidAlive: (pid) => pid === process.pid }).status, STATUS.UNKNOWN);

    // Corrupted file test:
    fs.writeFileSync(path.join(testDir, 'corrupt.json'), 'NOT VALID JSON', 'utf8');
    const corruptedRead = readAllSessionsFromDir(testDir);
    assert.strictEqual(corruptedRead.some(s => s.status === STATUS.UNKNOWN && s.reason.includes('corrupted')), true);

    console.log('All LetItCook integration tests passed.');
  } finally {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

function testOpenCodeIdleSignalsAreConservative() {
  const cooking = { session_id: 'idle-test', status: STATUS.COOKING, agent: 'opencode' };
  const waiting = { ...cooking, status: STATUS.YOUR_TURN };
  const failed = { ...cooking, status: STATUS.BURN, reason: 'error:explicit failure' };
  const completed = { ...cooking, status: STATUS.DONE, reason: 'status:done' };

  for (const previous of [null, cooking, waiting]) {
    const idle = mapOpenCodeEvent({
      type: 'session.idle',
      properties: { sessionID: 'idle-test' },
    }, previous);
    assert.strictEqual(idle.status, STATUS.UNKNOWN, 'session.idle without terminal evidence remains Unknown');
  }

  const burnAfterIdle = mapOpenCodeEvent({
    type: 'session.idle', properties: { sessionID: 'idle-test' },
  }, failed);
  assert.strictEqual(burnAfterIdle.status, STATUS.BURN, 'idle must preserve an explicit Burn state');
  assert.strictEqual(burnAfterIdle.reason, failed.reason, 'idle must preserve the failure reason');

  const doneAfterIdle = mapOpenCodeEvent({
    type: 'session.idle', properties: { sessionID: 'idle-test' },
  }, completed);
  assert.strictEqual(doneAfterIdle.status, STATUS.DONE, 'idle must preserve an already verified Done state');

  assert.strictEqual(mapOpenCodeEvent({
    type: 'session.status', properties: { sessionID: 'idle-test', status: 'idle' },
  }).status, STATUS.UNKNOWN, 'idle status without prior evidence is Unknown');
  assert.strictEqual(mapOpenCodeEvent({
    type: 'session.status', properties: { sessionID: 'idle-test', status: 'idle' },
  }, cooking).status, STATUS.COOKING, 'idle status does not infer Done');
  assert.strictEqual(mapOpenCodeEvent({
    type: 'session.compacted', properties: { sessionID: 'idle-test' },
  }, waiting).status, STATUS.YOUR_TURN, 'compaction preserves prior known state rather than claiming completion');
  assert.strictEqual(mapOpenCodeEvent({
    type: 'session.compacted', properties: { sessionID: 'idle-test' },
  }).status, STATUS.UNKNOWN, 'compaction without prior state is Unknown');
}

function testExplicitCompletionAndNotificationEvaluation() {
  const sid = 'opencode-completion-test';
  let state = mapOpenCodeEvent({
    type: 'session.created',
    properties: { sessionID: sid },
  });
  state = mapOpenCodeEvent({
    type: 'message.updated',
    properties: { info: { id: 'user-1', sessionID: sid, role: 'user' } },
  }, state);
  state = mapOpenCodeEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'assistant-1', sessionID: sid, role: 'assistant', parentID: 'user-1',
        finish: 'stop', time: { completed: Date.now() },
      },
    },
  }, state);
  assert.strictEqual(state.status, STATUS.COOKING, 'completion metadata alone waits for session idle');

  state = mapOpenCodeEvent({
    type: 'session.status',
    properties: { sessionID: sid, status: { type: 'idle' } },
  }, state);
  assert.strictEqual(state.status, STATUS.DONE, 'completed assistant response followed by OpenCode idle is Done');
  state = mapOpenCodeEvent({ type: 'session.idle', properties: { sessionID: sid } }, state);
  assert.strictEqual(state.status, STATUS.DONE, 'the following session.idle preserves verified Done');

  const tracker = new NotificationTracker({ notifyDone: true, suppressInitial: false });
  tracker.processSessions([{ session_id: sid, agent: 'opencode', status: STATUS.COOKING }]);
  const events = tracker.processSessions([state]);
  assert.strictEqual(events.length, 1, 'verified completion reaches notification evaluation');
  assert.strictEqual(events[0].session.status, STATUS.DONE);

  let withTool = mapOpenCodeEvent({ type: 'session.created', properties: { sessionID: sid } });
  withTool = mapOpenCodeEvent({
    type: 'message.updated', properties: { info: { id: 'user-2', sessionID: sid, role: 'user' } },
  }, withTool);
  withTool = mapOpenCodeEvent({
    type: 'message.part.updated',
    properties: { part: { id: 'tool-part', sessionID: sid, messageID: 'assistant-2', type: 'tool' } },
  }, withTool);
  withTool = mapOpenCodeEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'assistant-2', sessionID: sid, role: 'assistant', parentID: 'user-2',
        finish: 'stop', time: { completed: Date.now() },
      },
    },
  }, withTool);
  withTool = mapOpenCodeEvent({
    type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } },
  }, withTool);
assert.strictEqual(withTool.status, STATUS.COOKING, 'finish stop with tool parts is not successful completion');
  assert.strictEqual(mapOpenCodeEvent({
    type: 'session.idle',
    properties: { sessionID: sid },
  }, withTool).status, STATUS.UNKNOWN, 'tool-call completion evidence cannot make idle Done');
}

function testMessageCompletionRaceConditions() {
  const sid = 'opencode-race-test';

  // Scenario: Assistant message arrives with completion evidence, then session.idle event
  let state = mapOpenCodeEvent({ type: 'session.created', properties: { sessionID: sid } });
  assert.strictEqual(state.status, STATUS.COOKING, 'session.created is COOKING');

  // User message
  state = mapOpenCodeEvent({
    type: 'message.updated',
    properties: { info: { id: 'user-1', sessionID: sid, role: 'user' } },
  }, state);
  assert.strictEqual(state.status, STATUS.COOKING, 'user message received');

  // Assistant message with completion metadata
  const now = Date.now();
  state = mapOpenCodeEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'assistant-1', sessionID: sid, role: 'assistant', parentID: 'user-1',
        finish: 'stop', time: { completed: now },
      },
    },
  }, state);
  assert.strictEqual(state.status, STATUS.COOKING, 'completion metadata alone');
  assert.strictEqual(state._completionCandidate, true, 'completion candidate must be set');

  // Preserve candidate through session.updated (intermediate event)
  state = mapOpenCodeEvent({ type: 'session.updated', properties: {} }, state);
  assert.strictEqual(state._completionCandidate, true, 'session.updated preserves valid candidate');

  // Add a legitimate session.idle - DONE should be established and preserved
  state = mapOpenCodeEvent({
    type: 'session.idle',
    properties: { sessionID: sid },
  }, state);
  assert.strictEqual(state.status, STATUS.DONE, 'legitimate idle establishes DONE');
  assert.strictEqual(state._completionCandidate, false, 'session.idle clears candidate for next cycle');

  // Subsequent user message and assistant message should start fresh cycle
  state = mapOpenCodeEvent({
    type: 'message.updated',
    properties: { info: { id: 'user-2', sessionID: sid, role: 'user' } },
  }, state);
  assert.strictEqual(state.status, STATUS.COOKING, 'new cycle must start fresh');
  assert.strictEqual(state._lastUserMessageId, 'user-2', 'new user ID must be tracked');
  assert.strictEqual(state._completionCandidate, false, 'cycle must start without completion evidence');

  // Assistant message with completion metadata should NOT be accepted (no valid parent)
  state = mapOpenCodeEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'assistant-2', sessionID: sid, role: 'assistant', parentID: 'user-1',
        finish: 'stop', time: { completed: Date.now() },
      },
    },
  }, state);
  assert.strictEqual(state.status, STATUS.COOKING, 'orphaned completion must not be accepted');
  assert.strictEqual(state._completionCandidate, false, 'orphaned completion must not be accepted');
}

function testExplicitSessionStatusIdleAfterUserRequest() {
  const sid = 'opencode-status-idle-test';

  // Scenario: session.status("idle") is sent WITHOUT completion candidate
  let state = mapOpenCodeEvent({ type: 'session.created', properties: { sessionID: sid } });
  assert.strictEqual(state.status, STATUS.COOKING, 'session.created');

  // Direct session.status idle (no candidate) does not infer Done
  state = mapOpenCodeEvent({
    type: 'session.status',
    properties: { sessionID: sid, status: { type: 'idle' } },
  }, state);
  assert.strictEqual(state.status, STATUS.COOKING, 'idle status without candidate does not infer Done');

  // session.idle without candidate becomes Unknown
  state = mapOpenCodeEvent({
    type: 'session.idle',
    properties: { sessionID: sid },
  }, state);
  assert.strictEqual(state.status, STATUS.UNKNOWN, 'session.idle without valid completion evidence is Unknown');
}

function testUserMessageDiffSummaryPreservesCompletionCandidate() {
  const sid = 'opencode-summary-race-test';

  // 1. Session created
  let state = mapOpenCodeEvent({ type: 'session.created', properties: { sessionID: sid } });

  // 2. Initial user message
  state = mapOpenCodeEvent({
    type: 'message.updated',
    properties: { info: { id: 'msg_user_1', sessionID: sid, role: 'user' } },
  }, state);
  assert.strictEqual(state.status, STATUS.COOKING);
  assert.strictEqual(state._lastUserMessageId, 'msg_user_1');

  // 3. Assistant completes with finish: stop
  state = mapOpenCodeEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg_asst_1', sessionID: sid, role: 'assistant', parentID: 'msg_user_1',
        finish: 'stop', time: { completed: Date.now() },
      },
    },
  }, state);
  assert.strictEqual(state.status, STATUS.COOKING);
  assert.strictEqual(state._completionCandidate, true, 'candidate set awaiting idle');

  // 4. OpenCode forks background fiber for SessionSummary.summarize, emitting message.updated
  // for the SAME user message id with summary diffs BEFORE idle.
  state = mapOpenCodeEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg_user_1', sessionID: sid, role: 'user', summary: { diffs: [] },
      },
    },
  }, state);
  assert.strictEqual(state.status, STATUS.COOKING, 'existing user message update must not reset cooking turn');
  assert.strictEqual(state._completionCandidate, true, 'candidate must survive late user message diff summary');

  // 5. session.status idle arrives
  state = mapOpenCodeEvent({
    type: 'session.status',
    properties: { sessionID: sid, status: { type: 'idle' } },
  }, state);
  assert.strictEqual(state.status, STATUS.DONE, 'status reaches Done upon idle with preserved candidate');

  // 6. session.idle arrives
  state = mapOpenCodeEvent({
    type: 'session.idle',
    properties: { sessionID: sid },
  }, state);
  assert.strictEqual(state.status, STATUS.DONE, 'session.idle preserves Done');

  // 7. Late user message summary arrives AFTER session has already transitioned to Done
  state = mapOpenCodeEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg_user_1', sessionID: sid, role: 'user', summary: { diffs: [] },
      },
    },
  }, state);
  assert.strictEqual(state.status, STATUS.DONE, 'late user message diff summary must NOT overwrite Done back to Cooking');

  // 8. Genuine new user prompt begins a new turn
  state = mapOpenCodeEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg_user_2', sessionID: sid, role: 'user',
      },
    },
  }, state);
  assert.strictEqual(state.status, STATUS.COOKING, 'new user message starts new cooking turn');
  assert.strictEqual(state._lastUserMessageId, 'msg_user_2');
  assert.strictEqual(state._completionCandidate, false, 'new turn resets candidate');
}

function testGlobalNonSessionEventsIgnored() {
  assert.strictEqual(mapOpenCodeEvent({ type: 'plugin.added', properties: {} }), null);
  assert.strictEqual(mapOpenCodeEvent({ type: 'catalog.updated', properties: {} }), null);
  assert.strictEqual(mapOpenCodeEvent({ type: 'session.status', properties: { sessionID: 'global' } }), null);
}

testOpenCodeIdleSignalsAreConservative();
testExplicitCompletionAndNotificationEvaluation();
testMessageCompletionRaceConditions();
testExplicitSessionStatusIdleAfterUserRequest();
testUserMessageDiffSummaryPreservesCompletionCandidate();
testGlobalNonSessionEventsIgnored();
testFullOpenCodeLifecycle();