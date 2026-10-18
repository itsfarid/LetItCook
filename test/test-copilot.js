import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATUS } from '../src/core/status.js';
import {
  parseWorkspaceYaml,
  mapCopilotEvent,
  readSessionFromDir,
  CopilotAdapter,
} from '../src/adapters/copilot/adapter.js';

function testYamlParser() {
  const yaml = `
id: test-uuid-1234
cwd: /home/user/project
git_root: /home/user/project
repository: user/project
branch: feature/auth
name: "Implement Auth Flow"
summary: 'Authentication feature'
created_at: 2026-10-06T11:12:36.484Z
updated_at: 2026-10-06T11:12:49.058Z
# comment line
unknown_flag: true
`;

  const parsed = parseWorkspaceYaml(yaml);
  assert.strictEqual(parsed.id, 'test-uuid-1234');
  assert.strictEqual(parsed.cwd, '/home/user/project');
  assert.strictEqual(parsed.name, 'Implement Auth Flow');
  assert.strictEqual(parsed.summary, 'Authentication feature');
  assert.strictEqual(parsed.branch, 'feature/auth');

  // Empty / invalid yaml handling
  assert.deepStrictEqual(parseWorkspaceYaml(null), {});
  assert.deepStrictEqual(parseWorkspaceYaml(''), {});
}

function testCopilotEventMapping() {
  // 1. session.start -> Cooking
  const evStart = mapCopilotEvent({
    type: 'session.start',
    data: {
      sessionId: 'cop_ses_1',
      context: { cwd: '/home/user/repo' },
    },
    timestamp: '2026-10-06T12:00:00.000Z',
  });
  assert.strictEqual(evStart.status, STATUS.COOKING);
  assert.strictEqual(evStart.agent, 'copilot');
  assert.strictEqual(evStart.session_id, 'cop_ses_1');
  assert.strictEqual(evStart.cwd, '/home/user/repo');

  // 2. assistant.turn_start -> Cooking
  const evTurnStart = mapCopilotEvent({
    type: 'assistant.turn_start',
    data: { turnId: '0' },
  }, evStart);
  assert.strictEqual(evTurnStart.status, STATUS.COOKING);

  // 3. tool.execution_start normal -> Cooking
  const evToolBash = mapCopilotEvent({
    type: 'tool.execution_start',
    data: { toolName: 'bash' },
  }, evTurnStart);
  assert.strictEqual(evToolBash.status, STATUS.COOKING);
  assert.strictEqual(evToolBash.reason, 'tool:bash');

  // 4. tool.execution_start ask_user -> Your Turn
  const evToolAsk = mapCopilotEvent({
    type: 'tool.execution_start',
    data: { toolName: 'ask_user' },
  }, evTurnStart);
  assert.strictEqual(evToolAsk.status, STATUS.YOUR_TURN);
  assert.strictEqual(evToolAsk.reason, 'tool:ask_user');

  // 5. permission.requested -> Your Turn (with realistic payload)
  const evPermReq = mapCopilotEvent({
    type: 'permission.requested',
    data: {
      permissionRequest: { kind: 'shell', intention: 'Run git status' },
    },
  }, evToolBash);
  assert.strictEqual(evPermReq.status, STATUS.YOUR_TURN);
  assert.ok(evPermReq.reason.includes('shell'));
  assert.ok(evPermReq.reason.includes('git status'));

  // 6. permission.completed -> Cooking
  const evPermComp = mapCopilotEvent({
    type: 'permission.completed',
    data: {},
  }, evPermReq);
  assert.strictEqual(evPermComp.status, STATUS.COOKING);

  // 7. assistant.turn_end -> Your Turn (agent awaiting user input, not Done)
  const evTurnEnd = mapCopilotEvent({
    type: 'assistant.turn_end',
    data: { turnId: '0' },
  }, evPermComp);
  assert.strictEqual(evTurnEnd.status, STATUS.YOUR_TURN);

  // 8. session.error -> Burn (from documented event, not arbitrary stderr)
  const evError = mapCopilotEvent({
    type: 'session.error',
    data: { errorType: 'rate_limit', message: 'Monthly quota exceeded' },
  }, evTurnStart);
  assert.strictEqual(evError.status, STATUS.BURN);
  assert.ok(evError.reason.includes('rate_limit'));

  // 9. session.task_complete success -> Done (authoritative completion signal)
  const evTaskDone = mapCopilotEvent({
    type: 'session.task_complete',
    data: { success: true, summary: 'Implemented auth feature' },
  }, evTurnStart);
  assert.strictEqual(evTaskDone.status, STATUS.DONE);
  assert.ok(evTaskDone.reason.includes('auth feature'));

  // 10. session.task_complete failure -> Burn
  const evTaskFail = mapCopilotEvent({
    type: 'session.task_complete',
    data: { success: false, summary: 'Tests failed' },
  }, evTurnStart);
  assert.strictEqual(evTaskFail.status, STATUS.BURN);

  // 11. user_input.requested -> Your Turn
  const evInputReq = mapCopilotEvent({
    type: 'user_input.requested',
    data: { question: 'Which branch?' },
  }, evTurnStart);
  assert.strictEqual(evInputReq.status, STATUS.YOUR_TURN);

  // 12. user_input.completed -> Cooking
  const evInputComp = mapCopilotEvent({
    type: 'user_input.completed',
    data: { answer: 'main' },
  }, evInputReq);
  assert.strictEqual(evInputComp.status, STATUS.COOKING);

  // 13. elicitation.requested -> Your Turn
  const evElicit = mapCopilotEvent({
    type: 'elicitation.requested',
    data: { message: 'Please confirm', elicitationSource: 'browser' },
  }, evTurnStart);
  assert.strictEqual(evElicit.status, STATUS.YOUR_TURN);

  // 14. abort user-initiated -> Your Turn (not Burn)
  const evAbortUser = mapCopilotEvent({
    type: 'abort',
    data: { reason: 'user initiated' },
  }, evTurnStart);
  assert.strictEqual(evAbortUser.status, STATUS.YOUR_TURN);

  // 15. abort error -> Burn
  const evAbortErr = mapCopilotEvent({
    type: 'abort',
    data: { reason: 'connection error' },
  }, evTurnStart);
  assert.strictEqual(evAbortErr.status, STATUS.BURN);

  // 16. session.shutdown after Done -> terminated, status preserved
  const evShutdownDone = mapCopilotEvent({
    type: 'session.shutdown',
    data: { shutdownType: 'routine' },
  }, evTaskDone);
  assert.strictEqual(evShutdownDone.terminated, true);
  assert.strictEqual(evShutdownDone.status, STATUS.DONE);

  // 17. session.shutdown after Cooking -> terminated, status Unknown
  const evShutdownCooking = mapCopilotEvent({
    type: 'session.shutdown',
    data: { shutdownType: 'routine' },
  }, evToolBash);
  assert.strictEqual(evShutdownCooking.terminated, true);
  assert.strictEqual(evShutdownCooking.status, STATUS.UNKNOWN);

  // 18. session.shutdown with errorReason -> Burn
  const evShutdownErr = mapCopilotEvent({
    type: 'session.shutdown',
    data: { shutdownType: 'error', errorReason: 'process crash' },
  }, evToolBash);
  assert.strictEqual(evShutdownErr.terminated, true);
  assert.strictEqual(evShutdownErr.status, STATUS.BURN);
}

function testCopilotDirectoryReadingAndSync() {
  const tmpCopilot = path.join(os.tmpdir(), `letitcook_copilot_test_${Date.now()}`);
  const tmpLetItCook = path.join(os.tmpdir(), `letitcook_state_test_${Date.now()}`);

  try {
    const ses1Dir = path.join(tmpCopilot, 'session-state', 'ses_active_1');
    const ses2Dir = path.join(tmpCopilot, 'session-state', 'ses_terminated_2');
    fs.mkdirSync(ses1Dir, { recursive: true });
    fs.mkdirSync(ses2Dir, { recursive: true });

    // Session 1: Active Cooking / Your Turn
    fs.writeFileSync(path.join(ses1Dir, 'workspace.yaml'), `
id: ses_active_1
cwd: /home/user/app1
name: Add Search
created_at: 2026-10-06T10:00:00.000Z
updated_at: 2026-10-06T10:05:00.000Z
`, 'utf8');

    const events1 = [
      JSON.stringify({ type: 'session.start', data: { sessionId: 'ses_active_1' }, timestamp: '2026-10-06T10:00:00.000Z' }),
      JSON.stringify({ type: 'assistant.turn_start', data: {}, timestamp: '2026-10-06T10:01:00.000Z' }),
      JSON.stringify({ type: 'permission.requested', data: { permission: 'bash:exec' }, timestamp: '2026-10-06T10:05:00.000Z' }),
    ].join('\n');
    fs.writeFileSync(path.join(ses1Dir, 'events.jsonl'), events1, 'utf8');

    // Session 2: Terminated session (shutdown after done)
    fs.writeFileSync(path.join(ses2Dir, 'workspace.yaml'), `
id: ses_terminated_2
cwd: /home/user/app2
name: Refactor DB
created_at: 2026-10-06T09:00:00.000Z
updated_at: 2026-10-06T09:10:00.000Z
`, 'utf8');

    const events2 = [
      JSON.stringify({ type: 'session.start', data: { sessionId: 'ses_terminated_2' }, timestamp: '2026-10-06T09:00:00.000Z' }),
      JSON.stringify({ type: 'assistant.turn_end', data: {}, timestamp: '2026-10-06T09:05:00.000Z' }),
      JSON.stringify({ type: 'session.shutdown', data: {}, timestamp: '2026-10-06T09:10:00.000Z' }),
    ].join('\n');
    fs.writeFileSync(path.join(ses2Dir, 'events.jsonl'), events2, 'utf8');

    const adapter = new CopilotAdapter();
    const now = new Date('2026-10-06T10:06:00.000Z').getTime();
    const detected = adapter.detectSessions({ copilotDir: tmpCopilot, now });

    assert.strictEqual(detected.length, 1, 'Only active session should be detected');
    assert.strictEqual(detected[0].session_id, 'ses_active_1');
    assert.strictEqual(detected[0].agent, 'copilot');
    assert.strictEqual(detected[0].status, STATUS.YOUR_TURN);
    assert.strictEqual(detected[0].title, 'Add Search');
    assert.strictEqual(detected[0].cwd, '/home/user/app1');

    // Test getSessionState
    const s1 = adapter.getSessionState('ses_active_1', { copilotDir: tmpCopilot, now });
    assert.strictEqual(s1.status, STATUS.YOUR_TURN);

    const sNone = adapter.getSessionState('nonexistent', { copilotDir: tmpCopilot, now });
    assert.strictEqual(sNone, null);

    // Test syncToStateDir
    // Add existing OpenCode session file in target dir to verify it is NOT deleted
    fs.mkdirSync(tmpLetItCook, { recursive: true });
    fs.writeFileSync(path.join(tmpLetItCook, 'opencode_ses_1.json'), JSON.stringify({
      session_id: 'opencode_ses_1',
      agent: 'opencode',
      status: STATUS.COOKING,
    }), 'utf8');

    const synced = adapter.syncToStateDir(tmpLetItCook, { copilotDir: tmpCopilot, now });
    assert.strictEqual(synced.length, 1);
    assert.strictEqual(fs.existsSync(path.join(tmpLetItCook, 'copilot_ses_active_1.json')), true);
    assert.strictEqual(fs.existsSync(path.join(tmpLetItCook, 'opencode_ses_1.json')), true, 'OpenCode file must remain intact');

    // Terminate session 1 and re-sync -> copilot file must be pruned
    fs.appendFileSync(path.join(ses1Dir, 'events.jsonl'), '\n' + JSON.stringify({ type: 'assistant.turn_end' }) + '\n' + JSON.stringify({ type: 'session.shutdown' }));
    adapter.syncToStateDir(tmpLetItCook, { copilotDir: tmpCopilot, now });
    assert.strictEqual(fs.existsSync(path.join(tmpLetItCook, 'copilot_ses_active_1.json')), false, 'Terminated Copilot file pruned');
    assert.strictEqual(fs.existsSync(path.join(tmpLetItCook, 'opencode_ses_1.json')), true, 'OpenCode file still intact');
  } finally {
    try {
      fs.rmSync(tmpCopilot, { recursive: true, force: true });
      fs.rmSync(tmpLetItCook, { recursive: true, force: true });
    } catch {}
  }
}

function testCopilotSyncFreshness() {
  const tmpCopilot = path.join(os.tmpdir(), `letitcook_fresh_${Date.now()}`);
  const tmpState = path.join(os.tmpdir(), `letitcook_fresh_state_${Date.now()}`);
  try {
    const now = Date.now();
    const mkSession = (id, updatedAgoMs, lastEvent) => {
      const dir = path.join(tmpCopilot, 'session-state', id);
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date(now - updatedAgoMs).toISOString();
      fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: /tmp/x\nname: ${id}\n`, 'utf8');
      const events = [
        { type: 'session.start', data: { sessionId: id }, timestamp: ts },
        ...(lastEvent ? [{ ...lastEvent, timestamp: ts }] : []),
      ].map(e => JSON.stringify(e)).join('\n');
      fs.writeFileSync(path.join(dir, 'events.jsonl'), events, 'utf8');
    };

    // Recent Done (5 min ago) -> synced
    mkSession('recent_done', 5 * 60 * 1000,
      { type: 'session.task_complete', data: { success: true, summary: 'ok' } });
    // Ancient Done (3h ago) -> skipped
    mkSession('ancient_done', 3 * 60 * 60 * 1000,
      { type: 'session.task_complete', data: { success: true, summary: 'old' } });
    // Stale Cooking (10 min, default staleMs 5min) -> skipped
    mkSession('stale_cooking', 10 * 60 * 1000, null);
    // Your Turn left 3h ago (no shutdown, e.g. killed terminal) -> skipped
    mkSession('ancient_turn_end', 3 * 60 * 60 * 1000, { type: 'assistant.turn_end', data: {} });

    const adapter = new CopilotAdapter();
    const synced = adapter.syncToStateDir(tmpState, { copilotDir: tmpCopilot, now });
    const ids = synced.map(s => s.session_id);
    assert.ok(ids.includes('recent_done'), 'recent Done is synced');
    assert.ok(!ids.includes('ancient_done'), 'ancient Done is skipped');
    assert.ok(!ids.includes('stale_cooking'), 'stale Cooking is skipped');
    assert.ok(!ids.includes('ancient_turn_end'), 'Your Turn older than maxAgeMs is skipped');
    assert.ok(fs.existsSync(path.join(tmpState, 'copilot_recent_done.json')));
    assert.ok(!fs.existsSync(path.join(tmpState, 'copilot_ancient_done.json')));
  } finally {
    try {
      fs.rmSync(tmpCopilot, { recursive: true, force: true });
      fs.rmSync(tmpState, { recursive: true, force: true });
    } catch {}
  }
}

// Unchanged sessions are not replayed again on later sync ticks; changed, added and
// deleted sessions are picked up on the next tick.
function testReplayCacheTracksChanges() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-copilot-cache-'));
  const originalRead = fs.readFileSync;
  let eventReads = 0;
  fs.readFileSync = (file, ...rest) => {
    if (String(file).endsWith('events.jsonl')) eventReads++;
    return originalRead(file, ...rest);
  };
  try {
    const stateDir = path.join(root, 'session-state');
    const ts = () => new Date().toISOString();
    const mk = (id, events) => {
      const dir = path.join(stateDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\n`);
      fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map(e => JSON.stringify({ ...e, timestamp: ts() })).join('\n') + '\n');
      return dir;
    };
    const start = id => ({ type: 'session.start', data: { sessionId: id } });
    const dirA = mk('cache-a', [start('cache-a')]);
    mk('cache-b', [start('cache-b')]);
    const adapter = new CopilotAdapter();
    const statuses = () => Object.fromEntries(adapter.detectSessions({ copilotDir: root }).map(x => [x.session_id, x.status]));

    assert.deepStrictEqual(statuses(), { 'cache-a': STATUS.COOKING, 'cache-b': STATUS.COOKING });
    assert.strictEqual(eventReads, 2, 'first tick replays both sessions');
    statuses();
    statuses();
    assert.strictEqual(eventReads, 2, 'unchanged sessions are not replayed again');

    fs.appendFileSync(path.join(dirA, 'events.jsonl'), JSON.stringify({ type: 'permission.requested', data: { sessionId: 'cache-a' }, timestamp: ts() }) + '\n');
    assert.deepStrictEqual(statuses(), { 'cache-a': STATUS.YOUR_TURN, 'cache-b': STATUS.COOKING }, 'changed session re-replayed, other unaffected');
    assert.strictEqual(eventReads, 3, 'only the changed session was replayed');

    mk('cache-c', [start('cache-c')]);
    fs.rmSync(path.join(stateDir, 'cache-b'), { recursive: true });
    assert.deepStrictEqual(statuses(), { 'cache-a': STATUS.YOUR_TURN, 'cache-c': STATUS.COOKING }, 'added session appears, deleted one disappears');
    assert.strictEqual(adapter._replayCache.size, 2, 'cache entry of the deleted session is dropped');

    // Staleness still follows the clock on cached sessions.
    const later = adapter.detectSessions({ copilotDir: root, now: Date.now() + 10 * 60 * 1000 });
    assert.ok(later.every(x => x.status === STATUS.UNKNOWN && x.stale), 'cached sessions still go stale over time');
  } finally {
    fs.readFileSync = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run() {
  testYamlParser();
  testCopilotEventMapping();
  testCopilotDirectoryReadingAndSync();
  testCopilotSyncFreshness();
  testReplayCacheTracksChanges();
  console.log('All Copilot adapter tests passed.');
}

run();
