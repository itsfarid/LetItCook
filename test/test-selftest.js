import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseModel, isApprovedRequest, summarizeReason, SELFTEST_COMMAND } from '../src/selftest.js';

function testParseModel() {
  assert.deepStrictEqual(parseModel('deepseek/deepseek-v4-pro'), { providerID: 'deepseek', modelID: 'deepseek-v4-pro' });
  assert.deepStrictEqual(parseModel('openrouter/anthropic/claude'), { providerID: 'openrouter', modelID: 'anthropic/claude' }, 'only the first slash splits');
  for (const bad of ['', 'noslash', '/model', 'provider/', null, undefined, 42]) {
    assert.strictEqual(parseModel(bad), null, `rejects ${String(bad)}`);
  }
}

function testOnlyTheSelftestCommandIsApproved() {
  assert.strictEqual(isApprovedRequest({ permission: 'bash', patterns: [SELFTEST_COMMAND] }), true);
  assert.strictEqual(isApprovedRequest({ action: 'bash', resources: [SELFTEST_COMMAND] }), true, 'v2 shape');
  for (const request of [
    null,
    { permission: 'bash', patterns: ['rm -rf /'] },
    { permission: 'bash', patterns: [`${SELFTEST_COMMAND}; rm -rf ~`] },
    { permission: 'bash', patterns: [SELFTEST_COMMAND, 'curl example.com'] },
    { permission: 'edit', patterns: [SELFTEST_COMMAND] },
    { permission: 'bash', patterns: [] },
    { permission: 'bash' },
  ]) {
    assert.strictEqual(isApprovedRequest(request), false, `rejects ${JSON.stringify(request)}`);
  }
}

function testSummarizeReason() {
  assert.strictEqual(summarizeReason('error:Model not found\n    at getModel (/x.js:1)'), 'error:Model not found', 'stack trace dropped');
  assert.strictEqual(summarizeReason('a\u001b[31mb\u0007c'), 'a[31mbc', 'control characters removed');
  assert.strictEqual(summarizeReason('x'.repeat(200)).length, 160);
  assert.strictEqual(summarizeReason(undefined), '');
}

// Failure paths must report FAIL, exit 1 and leave no temporary project behind.
function testFailurePathsCleanUp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-selftest-test-'));
  try {
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(tmp);
    const earlyExit = path.join(root, 'opencode-exits');
    fs.writeFileSync(earlyExit, '#!/bin/sh\necho "boom"\nexit 3\n', { mode: 0o755 });

    for (const [bin, expected] of [
      [path.join(root, 'missing-opencode'), 'Could not start opencode'],
      [earlyExit, 'exited early'],
    ]) {
      const result = spawnSync(process.execPath, ['src/selftest.js', '--no-ask', '--model', 'p/m'], {
        encoding: 'utf8',
        env: { ...process.env, OPENCODE_BIN: bin, TMPDIR: tmp, XDG_STATE_HOME: path.join(root, 'state'), LETITCOOK_STATE_DIR: '' },
        timeout: 30000,
      });
      assert.strictEqual(result.status, 1, `${expected}: exits 1 (${result.stderr})`);
      assert.match(result.stdout, /Self-test \.+ FAIL/, `${expected}: reported as FAIL`);
      assert.ok(result.stdout.includes(expected), `${expected}: explains the failure`);
      assert.ok(result.stdout.includes('Cleaned up'), `${expected}: cleanup ran`);
      assert.deepStrictEqual(fs.readdirSync(tmp), [], `${expected}: temporary project removed`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testHelpAndBadArguments() {
  const help = spawnSync(process.execPath, ['src/selftest.js', '--help'], { encoding: 'utf8' });
  assert.strictEqual(help.status, 0);
  assert.ok(help.stdout.includes(SELFTEST_COMMAND), 'help names the only approved command');
  const bad = spawnSync(process.execPath, ['src/selftest.js', '--model', 'nope'], { encoding: 'utf8', env: { ...process.env, OPENCODE_BIN: '/nonexistent' } });
  assert.strictEqual(bad.status, 1);
  assert.ok(bad.stdout.includes('Invalid model'), 'invalid model is reported');
  const unknown = spawnSync(process.execPath, ['src/selftest.js', '--bogus'], { encoding: 'utf8' });
  assert.strictEqual(unknown.status, 2);
}

function run() {
  testParseModel();
  testOnlyTheSelftestCommandIsApproved();
  testSummarizeReason();
  testHelpAndBadArguments();
  testFailurePathsCleanUp();
  console.log('All LetItCook self-test tool tests passed.');
}

run();
