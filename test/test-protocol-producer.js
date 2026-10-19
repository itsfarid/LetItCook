// The reference producer (examples/protocol-producer.mjs) as a fake CLI process: it reports
// through the command transport, without any model or API key.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { validateLines } from '../src/protocol/validate.js';

const PRODUCER = path.resolve('examples/protocol-producer.mjs');

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-producer-'));
}
const env = h => ({ PATH: process.env.PATH, HOME: h, XDG_STATE_HOME: h });
const sessionFiles = h => {
  const dir = path.join(h, 'letitcook', 'sessions');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
};

function testScenariosAndRecording() {
  const expected = { success: 'done', permission: 'done', failure: 'burn', cancel: 'your_turn', limited: 'your_turn' };
  for (const [scenario, last] of Object.entries(expected)) {
    const h = home();
    try {
      const record = path.join(h, 'events.jsonl');
      const run = spawnSync(process.execPath, [PRODUCER, '--scenario', scenario, '--delay', '0', '--record', record], { env: env(h), encoding: 'utf8' });
      assert.strictEqual(run.status, 0, run.stderr);
      assert.deepStrictEqual(sessionFiles(h), [], `${scenario}: the session is ended at the end`);
      const lines = fs.readFileSync(record, 'utf8').split('\n');
      const { results, summary, rejected } = validateLines(lines);
      assert.strictEqual(rejected, 0, `${scenario}: every event is valid`);
      const statuses = results.filter(r => r.status).map(r => r.status);
      assert.strictEqual(statuses[statuses.length - 2], last, `${scenario}: final state before the session ends`);
      if (scenario === 'limited') {
        assert.ok(!summary[0].reached.includes('done'), 'a limited producer never reaches Done');
        assert.deepStrictEqual(summary[0].reached, ['cooking', 'your_turn']);
        assert.deepStrictEqual(summary[0].capabilities, [], 'it declares no outcome');
      }
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  }
}

function testDryRunSendsNothing() {
  const h = home();
  try {
    const record = path.join(h, 'events.jsonl');
    spawnSync(process.execPath, [PRODUCER, '--scenario', 'success', '--delay', '0', '--dry-run', '--record', record], { env: env(h) });
    assert.ok(!fs.existsSync(path.join(h, 'letitcook')), 'nothing sent');
    assert.ok(fs.readFileSync(record, 'utf8').trim().split('\n').length >= 5);
    assert.strictEqual(spawnSync(process.execPath, [PRODUCER, '--scenario', 'nope'], { env: env(h) }).status, 2);
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
}

async function testKeepHoldsTheFinalStateUntilStopped() {
  const h = home();
  try {
    const child = spawn(process.execPath, [PRODUCER, '--scenario', 'success', '--delay', '0', '--keep'], { env: env(h) });
    await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; if (out.includes('waiting')) resolve(); });
      child.on('exit', () => reject(new Error('exited early')));
    });
    const [file] = sessionFiles(h);
    const state = JSON.parse(fs.readFileSync(path.join(h, 'letitcook', 'sessions', file), 'utf8'));
    assert.strictEqual(state.status, 'done');
    assert.strictEqual(state.pid, child.pid, 'the fake CLI is the watched process');
    const exited = new Promise(resolve => child.on('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    assert.deepStrictEqual(sessionFiles(h), [], 'stopping it ends the session');
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
}

testScenariosAndRecording();
testDryRunSendsNothing();
testKeepHoldsTheFinalStateUntilStopped().then(() => {
  console.log('All LetItCook reference producer tests passed.');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
