// Fake `opencode serve` for the self-test tests. It drives the real LetItCook OpenCode
// plugin, so state files are genuine, and stands in for the GNOME extension by keeping
// the notification cache with NotificationTracker (same schema as the extension).
//
// FAKE_OPENCODE_MODE (comma-separated):
//   success         full flow: Cooking -> permission -> (approve) -> Done
//   hang-after-ask  stop after the permission request; never finishes
//   hang-requests   once the permission is pending, never answer HTTP requests
//   exit-after-ask  exit on its own right after the permission request
//   slow-start      wait 5 s before listening
//   ignore-sigterm  ignore SIGTERM (needs SIGKILL)
//   idle            do nothing (decoy process)
// FAKE_OPENCODE_LOG: file receiving one JSON line per notable event.

import fs from 'node:fs';
import http from 'node:http';
import { LetItCookPlugin } from '../../src/adapters/opencode/plugin.js';
import { getSessionDir, readAllSessionsFromDir } from '../../src/adapters/opencode/adapter.js';
import { NotificationTracker } from '../../src/core/notification.js';
import { getCachePath } from '../../src/notify.js';

const modes = new Set((process.env.FAKE_OPENCODE_MODE || 'success').split(','));
const logFile = process.env.FAKE_OPENCODE_LOG;
const log = (event, extra = {}) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ event, pid: process.pid, ...extra })}\n`);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

log('start');
if (modes.has('ignore-sigterm')) process.on('SIGTERM', () => log('sigterm-ignored'));
if (modes.has('idle')) {
  setInterval(() => {}, 1000);
} else {
  const expectedAuth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD || ''}`).toString('base64')}`;
  const plugin = await LetItCookPlugin({});
  const emit = (type, properties) => plugin.event({ event: { id: 'evt', type, properties } });
  const pending = new Map();
  let hangAll = false;

  const tracker = new NotificationTracker({ cachePath: getCachePath(), notifyDone: true, suppressInitial: false });
  setInterval(() => tracker.processSessions(readAllSessionsFromDir(getSessionDir())), 50);

  const runPrompt = async (sid) => {
    await emit('message.updated', { info: { id: 'msg_user', sessionID: sid, role: 'user' } });
    await sleep(300);
    await plugin['tool.execute.before']({ tool: 'bash', sessionID: sid, callID: 'call_1' }, {});
    const request = {
      id: 'per_selftest', sessionID: sid, permission: 'bash', patterns: ['echo letitcook-selftest'],
      always: ['echo *'], metadata: { command: 'echo letitcook-selftest' },
    };
    pending.set(request.id, request);
    await emit('permission.asked', request);
    log('asked', { sid });
    if (modes.has('hang-requests')) hangAll = true;
    if (modes.has('exit-after-ask')) setTimeout(() => { log('exiting'); process.exit(0); }, 100);
  };

  const finish = async (sid, reply) => {
    await emit('permission.replied', { sessionID: sid, requestID: 'per_selftest', reply });
    if (reply !== 'once' || modes.has('hang-after-ask')) return;
    await sleep(400);
    await plugin['tool.execute.after']({ tool: 'bash', sessionID: sid, callID: 'call_1' }, {});
    await emit('message.updated', { info: {
      id: 'msg_assistant', sessionID: sid, role: 'assistant', parentID: 'msg_user',
      finish: 'stop', time: { completed: Date.now() },
    } });
    await emit('session.status', { sessionID: sid, status: { type: 'idle' } });
    await emit('session.idle', { sessionID: sid });
  };

  const server = http.createServer(async (req, res) => {
    if (hangAll) { log('hung', { method: req.method, url: req.url }); return; }
    if (req.headers.authorization !== expectedAuth) { res.writeHead(401).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : {};
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(value === undefined ? '' : JSON.stringify(value));
    };
    log('request', { method: req.method, url: req.url, reply: json.reply });

    let match;
    if (req.method === 'POST' && req.url === '/session') {
      const sid = `ses_fake${process.pid}`;
      await emit('session.created', { info: { id: sid } });
      send(200, { id: sid });
    } else if (req.method === 'POST' && (match = req.url.match(/^\/session\/([^/]+)\/prompt_async$/))) {
      send(204);
      runPrompt(match[1]);
    } else if (req.method === 'GET' && req.url === '/permission') {
      send(200, [...pending.values()]);
    } else if (req.method === 'POST' && (match = req.url.match(/^\/permission\/([^/]+)\/reply$/))) {
      const request = pending.get(match[1]);
      pending.delete(match[1]);
      send(200, true);
      if (request) finish(request.sessionID, json.reply);
    } else if (req.method === 'POST' && /^\/session\/[^/]+\/abort$/.test(req.url)) {
      send(200, true);
    } else if (req.method === 'DELETE' && (match = req.url.match(/^\/session\/([^/]+)$/))) {
      await emit('session.deleted', { info: { id: match[1] } });
      send(200, true);
    } else {
      send(404);
    }
  });

  if (modes.has('slow-start')) await sleep(5000);
  server.listen(0, '127.0.0.1', () => {
    console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`);
  });
}
