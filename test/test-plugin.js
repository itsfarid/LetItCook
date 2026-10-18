import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LetItCookPlugin } from '../src/adapters/opencode/plugin.js';
import { STATUS, aggregateState } from '../src/core/status.js';
import { NotificationTracker } from '../src/core/notification.js';
import { readAllSessionsFromDir } from '../src/adapters/opencode/adapter.js';

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
