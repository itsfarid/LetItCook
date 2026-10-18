import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateLines } from '../src/protocol/validate.js';

const T = 1_800_000_000_000;
const ev = (n, type, extra = {}) => JSON.stringify({ schema: 1, agent: 'mycli', session_id: 's1', event_id: `e${n}`, type, time: T + n, ...extra });

function testReport() {
  const secret = 'sk-SECRET-VALIDATE-0123456789';
  const lines = [
    ev(1, 'turn.started', { turn_id: 't1', capabilities: ['requests', 'complete'] }),
    ev(2, 'request.opened', { turn_id: 't1', request_id: 'p1' }),
    ev(3, 'request.resolved', { request_id: 'p1' }),
    ev(4, 'turn.failed', { turn_id: 't1' }),
    ev(5, 'turn.completed', { turn_id: 't1' }),
    ev(5, 'turn.completed', { turn_id: 't1' }),
    ev(6, 'turn.paused'),
    'not json',
    ev(7, 'activity', { subject: `${secret} x` }),
    JSON.stringify({ schema: 1, agent: 'claude', session_id: 's', event_id: 'x', type: 'activity', time: T }),
    '',
  ];
  const { results, summary, rejected } = validateLines(lines);
  const brief = results.map(r => `${r.line}:${r.result}:${r.reason || r.status}`);
  assert.deepStrictEqual(brief, [
    '1:accepted:cooking',
    '2:accepted:your_turn',
    '3:accepted:cooking',
    '4:no_effect:cooking',
    '5:accepted:done',
    '6:no_effect:done',
    '7:ignored:unknown_type',
    '8:rejected:invalid_json',
    '9:rejected:invalid_subject',
    '10:rejected:reserved_agent',
  ]);
  assert.strictEqual(rejected, 3);
  assert.deepStrictEqual(summary, [{ session: 'mycli/s1', reached: ['cooking', 'done', 'your_turn'], capabilities: ['complete', 'requests'] }]);
  assert.ok(!JSON.stringify(results).includes(secret), 'values are never echoed');
}

function testCommandLine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letitcook-validate-'));
  try {
    const good = path.join(dir, 'good.jsonl');
    fs.writeFileSync(good, `${ev(1, 'turn.started')}\n${ev(2, 'turn.ended')}\n`);
    const ok = spawnSync(process.execPath, ['src/protocol/validate.js', good], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, XDG_STATE_HOME: dir } });
    assert.strictEqual(ok.status, 0);
    assert.match(ok.stdout, /line 2: accepted turn\.ended mycli\/s1 -> your_turn/);
    assert.match(ok.stdout, /mycli\/s1: reached cooking, your_turn; capabilities not declared/);
    assert.ok(!fs.existsSync(path.join(dir, 'letitcook')), 'writes nothing');
    const bad = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(bad, 'nope\n');
    assert.strictEqual(spawnSync(process.execPath, ['src/protocol/validate.js', bad], { encoding: 'utf8' }).status, 1);
    assert.strictEqual(spawnSync(process.execPath, ['src/protocol/validate.js'], { encoding: 'utf8' }).status, 2);
    assert.strictEqual(spawnSync(process.execPath, ['src/protocol/validate.js', dir], { encoding: 'utf8' }).status, 2, 'not a regular file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

testReport();
testCommandLine();
console.log('All LetItCook protocol validator tests passed.');
