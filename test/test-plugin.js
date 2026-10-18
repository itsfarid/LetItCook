import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LetItCookPlugin } from '../src/adapters/opencode/plugin.js';
import { STATUS, aggregateState } from '../src/core/status.js';
import { NotificationTracker } from '../src/core/notification.js';
import { readAllSessionsFromDir, extractSessionId, mapOpenCodeEvent } from '../src/adapters/opencode/adapter.js';

async function testTerminalFilesSurvivePluginProcessExit() {
  const testDir = path.join(os.tmpdir(), `letitcook_exit_${Date.now()}`);
  const pluginUrl = pathToFileURL(path.resolve('src/adapters/opencode/plugin.js')).href;
  const childScript = `
    const { LetItCookPlugin } = await import(${JSON.stringify(pluginUrl)});
    const plugin = await LetItCookPlugin({});
    const emit = (type, properties) => plugin.event({ event: { type, properties } });
    for (const sid of ['exit_done', 'exit_burn']) {
      await emit('session.created', { sessionID: sid });
    }
    await emit('message.updated', { info: { id: 'user', sessionID: 'exit_done', role: 'user' } });
    await emit('message.updated', { info: {
      id: 'assistant', sessionID: 'exit_done', role: 'assistant', parentID: 'user',
      finish: 'stop', time: { completed: Date.now() },
    } });
    await emit('session.status', { sessionID: 'exit_done', status: { type: 'idle' } });
    await emit('session.error', { sessionID: 'exit_burn', error: { message: 'test failure' } });
  `;

  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
      encoding: 'utf8',
      env: { ...process.env, LETITCOOK_STATE_DIR: testDir },
    });
    assert.strictEqual(child.status, 0, `plugin subprocess exits successfully: ${child.stderr}`);

    const donePath = path.join(testDir, 'exit_done.json');
    const burnPath = path.join(testDir, 'exit_burn.json');
    assert.strictEqual(fs.existsSync(donePath), true, 'Done session remains after plugin process exit');
    assert.strictEqual(fs.existsSync(burnPath), true, 'Burn session remains after plugin process exit');

    const terminalSessions = [donePath, burnPath].map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
    const notifications = new NotificationTracker({ notifyDone: true, suppressInitial: false });
    notifications.processSessions(terminalSessions.map(session => ({ ...session, status: STATUS.COOKING })));
    const events = notifications.processSessions(terminalSessions);
    assert.deepStrictEqual(new Set(events.map(event => event.session.status)), new Set([STATUS.DONE, STATUS.BURN]),
      'terminal states reach notification evaluation before extension cleanup');

    // Match the legacy extension's ordering: evaluate notifications, then remove terminated files.
    for (const file of [donePath, burnPath]) fs.unlinkSync(file);
    assert.strictEqual(fs.existsSync(donePath), false, 'extension cleanup can remove Done after notification evaluation');
    assert.strictEqual(fs.existsSync(burnPath), false, 'extension cleanup can remove Burn after notification evaluation');
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

// Regression (reproduced with OpenCode 1.18.35): two parallel bash permission requests;
// approving the first flipped LetItCook to Cooking while OpenCode was still blocked on
// the second request. Pending requests must keep the session in Your Turn.
async function testPendingPermissionRequestsKeepYourTurn() {
  const plugin = await LetItCookPlugin({});
  const dir = process.env.LETITCOOK_STATE_DIR;
  const emit = (type, properties) => plugin.event({ event: { id: 'evt', type, properties } });
  const state = sid => JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8'));
  const tracker = new NotificationTracker({ notifyDone: false, suppressInitial: false });
  const notifyStatuses = sid => tracker.processSessions([state(sid)]).map(e => e.session.status);

  const shapes = {
    v1: {
      ask: (sid, id, cmd) => emit('permission.asked', { id, sessionID: sid, permission: 'bash', patterns: [cmd], always: [], metadata: {} }),
      reply: (sid, id, reply) => emit('permission.replied', { sessionID: sid, requestID: id, reply }),
    },
    v2: {
      ask: (sid, id, cmd) => emit('permission.v2.asked', { id, sessionID: sid, action: 'bash', resources: [cmd], save: [], metadata: {} }),
      reply: (sid, id, reply) => emit('permission.v2.replied', { sessionID: sid, requestID: id, reply }),
    },
  };

  for (const [name, shape] of Object.entries(shapes)) {
    const sid = `pending_${name}`;
    await emit('message.updated', { info: { id: `u_${name}`, sessionID: sid, role: 'user' } });
    await plugin['tool.execute.before']({ tool: 'bash', sessionID: sid, callID: 'a' }, {});
    await plugin['tool.execute.before']({ tool: 'bash', sessionID: sid, callID: 'b' }, {});
    assert.deepStrictEqual(notifyStatuses(sid), [], `${name}: Cooking does not notify`);
    await shape.ask(sid, 'per_a', 'echo a');
    await shape.ask(sid, 'per_b', 'echo b');
    assert.strictEqual(state(sid).status, STATUS.YOUR_TURN, `${name}: asked => Your Turn`);
    assert.deepStrictEqual(notifyStatuses(sid), [STATUS.YOUR_TURN], `${name}: one Your Turn notification`);

    await shape.reply(sid, 'per_a', 'once');
    assert.strictEqual(state(sid).status, STATUS.YOUR_TURN, `${name}: one request still pending => Your Turn`);
    assert.match(state(sid).reason, /echo b/, `${name}: reason names the request still pending`);
    await plugin['tool.execute.after']({ tool: 'bash', sessionID: sid, callID: 'a' }, {});
    assert.strictEqual(state(sid).status, STATUS.YOUR_TURN, `${name}: finished sibling tool does not hide the pending request`);
    assert.deepStrictEqual(notifyStatuses(sid), [], `${name}: no duplicate notification`);

    await shape.reply(sid, 'per_b', 'once');
    assert.strictEqual(state(sid).status, STATUS.COOKING, `${name}: all requests answered => Cooking`);
    await plugin['tool.execute.after']({ tool: 'bash', sessionID: sid, callID: 'b' }, {});
    assert.strictEqual(state(sid).status, STATUS.COOKING);
    assert.deepStrictEqual(notifyStatuses(sid), [], `${name}: Cooking does not notify`);

    await shape.ask(sid, 'per_c', 'echo c');
    assert.deepStrictEqual(notifyStatuses(sid), [STATUS.YOUR_TURN], `${name}: a later request notifies again`);
    await shape.reply(sid, 'per_c', 'reject');
    assert.strictEqual(state(sid).status, STATUS.COOKING, `${name}: single request answered => Cooking (unchanged behaviour)`);
  }

  // Questions use the same request/answer lifecycle.
  await emit('question.asked', { id: 'que_1', sessionID: 'pending_q', questions: [] });
  await emit('question.asked', { id: 'que_2', sessionID: 'pending_q', questions: [] });
  await emit('question.rejected', { sessionID: 'pending_q', requestID: 'que_1' });
  assert.strictEqual(state('pending_q').status, STATUS.YOUR_TURN, 'second question still pending');
  await emit('question.replied', { sessionID: 'pending_q', requestID: 'que_2', answers: [] });
  assert.strictEqual(state('pending_q').status, STATUS.COOKING, 'all questions answered');

  // v2 question events: rejecting the last pending question resumes Cooking.
  await emit('message.updated', { info: { id: 'u_q2', sessionID: 'pending_q2', role: 'user' } });
  await emit('question.v2.asked', { id: 'que_v2_1', sessionID: 'pending_q2', questions: [] });
  await emit('question.v2.asked', { id: 'que_v2_2', sessionID: 'pending_q2', questions: [] });
  await emit('question.v2.rejected', { sessionID: 'pending_q2', requestID: 'que_v2_1' });
  assert.strictEqual(state('pending_q2').status, STATUS.YOUR_TURN, 'v2: second question still pending');
  await emit('question.v2.rejected', { sessionID: 'pending_q2', requestID: 'que_v2_2' });
  assert.strictEqual(state('pending_q2').status, STATUS.COOKING, 'v2: last question rejected => Cooking');
  assert.strictEqual(state('pending_q2').reason, 'question.v2.rejected:replied');

  // A missed reply can never pin Your Turn: the loop ending clears pending requests.
  await emit('message.updated', { info: { id: 'u_stuck', sessionID: 'pending_stuck', role: 'user' } });
  await emit('permission.asked', { id: 'per_lost', sessionID: 'pending_stuck', permission: 'bash', patterns: [] });
  await emit('session.status', { sessionID: 'pending_stuck', status: { type: 'idle' } });
  await emit('session.idle', { sessionID: 'pending_stuck' });
  assert.strictEqual(state('pending_stuck').status, STATUS.UNKNOWN, 'idle without completion evidence stays Unknown, never Done');
  await emit('message.updated', { info: { id: 'u_stuck_2', sessionID: 'pending_stuck', role: 'user' } });
  await plugin['tool.execute.after']({ tool: 'bash', sessionID: 'pending_stuck' }, {});
  assert.strictEqual(state('pending_stuck').status, STATUS.COOKING, 'next turn is Cooking, not a stale Your Turn');

  // Errors still win over pending requests and also clear them.
  await emit('permission.asked', { id: 'per_err', sessionID: 'pending_err', permission: 'bash', patterns: [] });
  await emit('session.error', { sessionID: 'pending_err', error: { message: 'boom' } });
  assert.strictEqual(state('pending_err').status, STATUS.BURN, 'session.error while pending => Burn');
  await emit('message.updated', { info: { id: 'u_err', sessionID: 'pending_err', role: 'user' } });
  assert.strictEqual(state('pending_err').status, STATUS.COOKING, 'new prompt after Burn => Cooking');

  // Malformed events (non-string type, missing properties) are ignored without throwing.
  const before = fs.readdirSync(dir).sort();
  for (const event of [{ type: 123 }, { type: {} }, { type: true }, { type: ['session.idle'] },
    { type: 123, properties: { sessionID: 'pending_v1' } }, { type: '', properties: { sessionID: 'pending_v1' } },
    { type: 'message.updated', properties: null }, { type: 'message.updated', properties: { info: null } }, null, {}]) {
    await plugin.event({ event });
  }
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'malformed events create no session files');
  assert.strictEqual(extractSessionId({ type: 42, properties: { info: { id: 'x' } } }), null);
  assert.strictEqual(mapOpenCodeEvent({ type: 42, properties: { sessionID: 's' } }), null);

  // Bookkeeping is process-local and never persisted.
  assert.strictEqual('_pendingRequests' in state('pending_v1'), false, 'pending bookkeeping not written to state file');
}

async function testPlugin() {
  const tmpDir = path.join(os.tmpdir(), `letitcook_plug_${Date.now()}`);
  process.env.LETITCOOK_STATE_DIR = tmpDir;

  try {
    const pluginInstance = await LetItCookPlugin({});
    assert.strictEqual(typeof pluginInstance.event, 'function');
    assert.strictEqual(typeof pluginInstance['tool.execute.before'], 'function');
    assert.strictEqual(typeof pluginInstance['tool.execute.after'], 'function');

    // 1. Session creation
    await pluginInstance.event({
      event: {
        type: 'session.created',
        properties: { sessionID: 'plug_ses_1', directory: '/home/user/project1', title: 'Plugin Test' },
      },
    });

    let sessions = readAllSessionsFromDir(tmpDir);
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].session_id, 'plug_ses_1');
    assert.strictEqual(sessions[0].status, STATUS.COOKING);

    // 2. Question tool hook -> Your Turn
    await pluginInstance['tool.execute.before']({
      sessionID: 'plug_ses_1',
      tool: 'ask_user_permission',
    });
    sessions = readAllSessionsFromDir(tmpDir);
    assert.strictEqual(sessions[0].status, STATUS.YOUR_TURN);

    // 3. Question tool finish -> Cooking
    await pluginInstance['tool.execute.after']({
      sessionID: 'plug_ses_1',
      tool: 'ask_user_permission',
    });
    sessions = readAllSessionsFromDir(tmpDir);
    assert.strictEqual(sessions[0].status, STATUS.COOKING);

    // 4. Session idle does not prove completion
    await pluginInstance.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'plug_ses_1' },
      },
    });
    sessions = readAllSessionsFromDir(tmpDir);
    assert.strictEqual(sessions[0].status, STATUS.UNKNOWN);

    // 5. Session deleted -> File deleted
    await pluginInstance.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'plug_ses_1' },
      },
    });
    sessions = readAllSessionsFromDir(tmpDir);
    assert.strictEqual(sessions.length, 0);

    // Completed assistant output after a tool-hook round trip remains associated with its session.
    const completionSession = 'plug_completion_ses';
    await pluginInstance.event({
      event: { type: 'session.created', properties: { sessionID: completionSession } },
    });
    await pluginInstance.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'user-message', sessionID: completionSession, role: 'user' } },
      },
    });
    await pluginInstance['tool.execute.before']({ sessionID: completionSession, tool: 'bash' });
    await pluginInstance['tool.execute.after']({ sessionID: completionSession, tool: 'bash' });
    await pluginInstance.event({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant-message', sessionID: completionSession, role: 'assistant',
            parentID: 'user-message', finish: 'stop', time: { completed: Date.now() },
          },
        },
      },
    });
    await pluginInstance.event({
      event: {
        type: 'session.status',
        properties: { sessionID: completionSession, status: { type: 'idle' } },
      },
    });
    await pluginInstance.event({ event: { type: 'session.idle', properties: { sessionID: completionSession } } });
    const completionFile = path.join(tmpDir, `${completionSession}.json`);
    assert.strictEqual(fs.existsSync(completionFile), true, 'session status is persisted under its session ID');
    const persisted = JSON.parse(fs.readFileSync(completionFile, 'utf8'));
    assert.strictEqual(persisted.status, STATUS.DONE, 'verified completion reaches persisted state');
    assert.strictEqual('_completionCandidate' in persisted, false, 'completion bookkeeping is not persisted');
    assert.strictEqual('_lastUserMessageId' in persisted, false, 'user-message bookkeeping is not persisted');
    assert.strictEqual('_toolMessageIds' in persisted, false, 'tool-message bookkeeping is not persisted');

    const toolSession = 'plug_tool_ses';
    await pluginInstance.event({ event: { type: 'session.created', properties: { sessionID: toolSession } } });
    await pluginInstance.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'tool-user', sessionID: toolSession, role: 'user' } },
      },
    });
    await pluginInstance.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: 'tool-part', sessionID: toolSession, messageID: 'tool-assistant', type: 'tool' },
        },
      },
    });
    await pluginInstance.event({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'tool-assistant', sessionID: toolSession, role: 'assistant',
            parentID: 'tool-user', finish: 'stop', time: { completed: Date.now() },
          },
        },
      },
    });
    await pluginInstance.event({
      event: { type: 'session.status', properties: { sessionID: toolSession, status: { type: 'idle' } } },
    });
    await pluginInstance.event({ event: { type: 'session.idle', properties: { sessionID: toolSession } } });
    const toolPersisted = JSON.parse(fs.readFileSync(path.join(tmpDir, `${toolSession}.json`), 'utf8'));
    assert.strictEqual(toolPersisted.status, STATUS.UNKNOWN, 'real tool-part event shape prevents false Done');
    await pluginInstance.event({
      event: { type: 'session.deleted', properties: { info: { id: toolSession } } },
    });
    assert.strictEqual(fs.existsSync(path.join(tmpDir, `${toolSession}.json`)), false,
      'session lifecycle info.id remains the session ID for deletion events');

    // Non-session engine events must not write global.json
    await pluginInstance.event({ event: { type: 'plugin.added', properties: {} } });
    assert.strictEqual(fs.existsSync(path.join(tmpDir, 'global.json')), false,
      'non-session event does not create phantom global.json');

    // Late user message diff summary must not overwrite completed Done session
    await pluginInstance.event({
      event: {
        type: 'message.updated',
        properties: {
          info: { id: 'user-message', sessionID: completionSession, role: 'user', summary: { diffs: [] } },
        },
      },
    });
    const completionPersistedAfterSummary = JSON.parse(fs.readFileSync(completionFile, 'utf8'));
    assert.strictEqual(completionPersistedAfterSummary.status, STATUS.DONE,
      'late user message diff summary does not reset Done back to Cooking');

    await testPendingPermissionRequestsKeepYourTurn();
    await testTerminalFilesSurvivePluginProcessExit();

    console.log('LetItCook plugin tests passed.');
  } finally {
    delete process.env.LETITCOOK_STATE_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

testPlugin();
