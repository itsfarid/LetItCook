import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LetItCookPlugin } from '../src/adapters/opencode/plugin.js';
import { STATUS, aggregateState } from '../src/core/status.js';
import { readAllSessionsFromDir } from '../src/adapters/opencode/adapter.js';

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

    console.log('LetItCook plugin tests passed.');
  } finally {
    delete process.env.LETITCOOK_STATE_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

testPlugin();
