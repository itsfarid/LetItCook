import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  STATUS,
  normalizeSession,
  aggregateState,
} from '../src/core/status.js';
import {
  writeSessionFile,
  readAllSessionsFromDir,
  deleteSessionFile,
  mapOpenCodeEvent,
} from '../src/adapters/opencode/adapter.js';

function testDoneSessionStaysWhilePidAlive() {
  const now = Date.now();
  const session = {
    session_id: 'ses_alive_done',
    agent: 'opencode',
    status: STATUS.DONE,
    pid: 1234,
    updated_at: now,
  };

  const norm = normalizeSession(session, {
    now,
    isPidAlive: (pid) => pid === 1234,
  });

  assert.strictEqual(norm.status, STATUS.DONE, 'Done status preserved while alive');
  assert.strictEqual(norm.terminated, false, 'Should not be marked terminated while alive');

  const agg = aggregateState([session], {
    now,
    isPidAlive: (pid) => pid === 1234,
  });
  assert.strictEqual(agg.status, STATUS.DONE, 'Aggregate should be Done');
  assert.strictEqual(agg.sessionCount, 1);
}

function testDoneSessionTerminatedWhenPidDies() {
  const now = Date.now();
  const session = {
    session_id: 'ses_dead_done',
    agent: 'opencode',
    status: STATUS.DONE,
    pid: 1234,
    updated_at: now,
  };

  const norm = normalizeSession(session, {
    now,
    isPidAlive: (pid) => false, // PID is dead
  });

  assert.strictEqual(norm.terminated, true, 'Done session with dead PID must be marked terminated');

  const agg = aggregateState([session], {
    now,
    isPidAlive: (pid) => false,
  });
  assert.strictEqual(agg.status, STATUS.UNKNOWN, 'Terminated session must be dropped, returning neutral/empty');
  assert.strictEqual(agg.sessionCount, 0, 'Terminated session must not be counted');
}

function testBurnSessionTerminatedWhenPidDies() {
  const now = Date.now();
  const session = {
    session_id: 'ses_dead_burn',
    agent: 'opencode',
    status: STATUS.BURN,
    pid: 1234,
    updated_at: now,
  };

  const norm = normalizeSession(session, {
    now,
    isPidAlive: (pid) => false, // PID is dead
  });

  assert.strictEqual(norm.terminated, true, 'Burn session with dead PID must be marked terminated');

  const agg = aggregateState([session], {
    now,
    isPidAlive: (pid) => false,
  });
  assert.strictEqual(agg.status, STATUS.UNKNOWN, 'Terminated burn session must be dropped');
  assert.strictEqual(agg.sessionCount, 0);
}

function testCookingCrashBecomesUnknown() {
  const now = Date.now();
  const session = {
    session_id: 'ses_crashed_cooking',
    agent: 'opencode',
    status: STATUS.COOKING,
    pid: 1234,
    updated_at: now,
  };

  const norm = normalizeSession(session, {
    now,
    isPidAlive: (pid) => false, // crashed
  });

  assert.strictEqual(norm.status, STATUS.UNKNOWN, 'Crashed cooking session becomes Unknown');
  assert.strictEqual(norm.stale, true, 'Marked stale');
  assert.strictEqual(norm.terminated, false, 'Not cleanly terminated, remains visible as unknown until cleaned');
}

function testMultiSessionStepwiseLifecycle() {
  const now = Date.now();
  const livePids = new Set([101, 102, 103]);
  const isPidAlive = (pid) => livePids.has(pid);

  const sesA = { session_id: 'A', agent: 'opencode', status: STATUS.DONE, pid: 101, updated_at: now };
  const sesB = { session_id: 'B', agent: 'opencode', status: STATUS.COOKING, pid: 102, updated_at: now };
  const sesC = { session_id: 'C', agent: 'opencode', status: STATUS.YOUR_TURN, pid: 103, updated_at: now };

  // All 3 alive
  let agg = aggregateState([sesA, sesB, sesC], { now, isPidAlive });
  assert.strictEqual(agg.status, STATUS.YOUR_TURN, 'A(Done)+B(Cooking)+C(YourTurn) => YourTurn');
  assert.strictEqual(agg.sessionCount, 3);

  // Session A terminates (PID 101 dies)
  livePids.delete(101);
  agg = aggregateState([sesA, sesB, sesC], { now, isPidAlive });
  assert.strictEqual(agg.status, STATUS.YOUR_TURN, 'A terminated => remaining B(Cooking)+C(YourTurn) => YourTurn');
  assert.strictEqual(agg.sessionCount, 2, 'Session A must disappear');

  // Scenario 2: A(Done), B(Done), C(Cooking)
  const pids2 = new Set([201, 202, 203]);
  const isPidAlive2 = (pid) => pids2.has(pid);

  const sA = { session_id: 'A', agent: 'opencode', status: STATUS.DONE, pid: 201, updated_at: now };
  const sB = { session_id: 'B', agent: 'opencode', status: STATUS.DONE, pid: 202, updated_at: now };
  const sC = { session_id: 'C', agent: 'opencode', status: STATUS.COOKING, pid: 203, updated_at: now };

  let agg2 = aggregateState([sA, sB, sC], { now, isPidAlive: isPidAlive2 });
  assert.strictEqual(agg2.status, STATUS.COOKING, 'A(Done)+B(Done)+C(Cooking) => Cooking');
  assert.strictEqual(agg2.sessionCount, 3);

  // A terminates
  pids2.delete(201);
  agg2 = aggregateState([sA, sB, sC], { now, isPidAlive: isPidAlive2 });
  assert.strictEqual(agg2.status, STATUS.COOKING, 'A terminated => B(Done)+C(Cooking) => Cooking');
  assert.strictEqual(agg2.sessionCount, 2);

  // C crashes (Cooking PID dies) -> becomes Unknown (stale), remains visible
  pids2.delete(203);
  agg2 = aggregateState([sA, sB, sC], { now, isPidAlive: isPidAlive2 });
  // A already terminated (removed). B alive Done. C crashed becomes Unknown.
  // sessionCount = B(Done) + C(Unknown) = 2; Unknown has lower priority than Done
  assert.strictEqual(agg2.status, STATUS.DONE, 'C crashed => B(Done)+C(Unknown) => Done');
  assert.strictEqual(agg2.sessionCount, 2, 'Crashed cooking session stays as Unknown, not dropped');

  // B terminates (Done + dead PID) -> terminated, dropped. C(Unknown) remains.
  pids2.delete(202);
  agg2 = aggregateState([sA, sB, sC], { now, isPidAlive: isPidAlive2 });
  // Only C(Unknown) remains
  assert.strictEqual(agg2.status, STATUS.UNKNOWN, 'B terminated => C(Unknown) only => Unknown');
  assert.strictEqual(agg2.sessionCount, 1, 'Only Unknown C remains');
}

function testFileSystemAutoPruning() {
  const tmpDir = path.join(os.tmpdir(), `letitcook_prune_${Date.now()}`);
  const livePids = new Set([301, 302]);
  const isPidAlive = (pid) => livePids.has(pid);

  try {
    const sDone = {
      session_id: 'ses_done_fs',
      agent: 'opencode',
      status: STATUS.DONE,
      pid: 301,
      updated_at: Date.now(),
    };
    const sCooking = {
      session_id: 'ses_cooking_fs',
      agent: 'opencode',
      status: STATUS.COOKING,
      pid: 302,
      updated_at: Date.now(),
    };

    writeSessionFile(sDone, tmpDir);
    writeSessionFile(sCooking, tmpDir);

    let active = readAllSessionsFromDir(tmpDir, { isPidAlive });
    assert.strictEqual(active.length, 2, 'Both files exist and active');

    // PID 301 (Done) dies
    livePids.delete(301);
    active = readAllSessionsFromDir(tmpDir, { isPidAlive });
    assert.strictEqual(active.length, 1, 'Terminated done session pruned from list');
    assert.strictEqual(active[0].session_id, 'ses_cooking_fs');

    // Verify file was deleted from disk
    assert.strictEqual(fs.existsSync(path.join(tmpDir, 'ses_done_fs.json')), false, 'Dead Done file deleted from disk');
    assert.strictEqual(fs.existsSync(path.join(tmpDir, 'ses_cooking_fs.json')), true, 'Active cooking file preserved');

    // PID 302 dies
    livePids.delete(302);
    // Cooking with dead PID becomes unknown (stale)
    active = readAllSessionsFromDir(tmpDir, { isPidAlive });
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].status, STATUS.UNKNOWN);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// Regression: dead-PID OpenCode sessions used to stay visible as Unknown forever
// (observed: five 1-4 day old files pinned the panel at Unknown). A recently
// crashed session must stay visible; one whose process is gone and that has had no
// update for the retention window is terminated (never promoted to Done).
function testDeadPidUnknownExpiresAfterRetention() {
  const now = Date.now();
  const dead = () => false;
  const alive = () => true;
  const hour = 60 * 60 * 1000;

  for (const status of [STATUS.COOKING, STATUS.YOUR_TURN, STATUS.UNKNOWN]) {
    const recent = normalizeSession({ session_id: `r_${status}`, status, pid: 999, updated_at: now - 10 * 60 * 1000 }, { now, isPidAlive: dead });
    assert.strictEqual(recent.status, STATUS.UNKNOWN, `${status}: recent dead session shows Unknown`);
    assert.strictEqual(recent.terminated, false, `${status}: recent dead session stays visible`);

    const old = normalizeSession({ session_id: `o_${status}`, status, pid: 999, updated_at: now - hour - 1000 }, { now, isPidAlive: dead });
    assert.strictEqual(old.status, STATUS.UNKNOWN, `${status}: expired dead session is never Done`);
    assert.strictEqual(old.terminated, true, `${status}: expired dead session is terminated`);

    const oldAlive = normalizeSession({ session_id: `a_${status}`, status, pid: 999, updated_at: now - 5 * hour }, { now, isPidAlive: alive });
    assert.strictEqual(oldAlive.terminated, false, `${status}: live process is never expired`);
  }

  // Without a PID there is no liveness to check: the session is removed one hour after its
  // last update (whatever the probe says), and kept before that.
  const noPid = normalizeSession({ session_id: 'np', status: STATUS.UNKNOWN, updated_at: now - 5 * hour }, { now, isPidAlive: dead });
  assert.strictEqual(noPid.terminated, true, 'PID-less sessions are removed an hour after their last update');
  const noPidRecent = normalizeSession({ session_id: 'np2', status: STATUS.UNKNOWN, updated_at: now - 30 * 60 * 1000 }, { now, isPidAlive: dead });
  assert.strictEqual(noPidRecent.terminated, false, 'PID-less sessions are kept within the hour');
  const noProbe = normalizeSession({ session_id: 'nq', status: STATUS.UNKNOWN, pid: 999, updated_at: now - 5 * hour }, { now });
  assert.strictEqual(noProbe.terminated, false, 'no liveness probe => no expiry');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook_expire_'));
  try {
    writeSessionFile({ session_id: 'ses_old_dead', agent: 'opencode', status: STATUS.UNKNOWN, pid: 999, updated_at: now - 2 * hour }, tmpDir);
    writeSessionFile({ session_id: 'ses_new_dead', agent: 'opencode', status: STATUS.COOKING, pid: 999, updated_at: now - 60 * 1000 }, tmpDir);
    const active = readAllSessionsFromDir(tmpDir, { now, isPidAlive: dead });
    assert.deepStrictEqual(active.map(s => s.session_id), ['ses_new_dead'], 'only the recent crash remains');
    assert.strictEqual(fs.existsSync(path.join(tmpDir, 'ses_old_dead.json')), false, 'expired file cleaned');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function run() {
  testDoneSessionStaysWhilePidAlive();
  testDoneSessionTerminatedWhenPidDies();
  testBurnSessionTerminatedWhenPidDies();
  testCookingCrashBecomesUnknown();
  testMultiSessionStepwiseLifecycle();
  testFileSystemAutoPruning();
  testDeadPidUnknownExpiresAfterRetention();
  console.log('All LetItCook lifecycle tests passed.');
}

run();
