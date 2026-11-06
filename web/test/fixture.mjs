import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
export async function fixture(port = 0) {
  const baseline = resolve(process.env.WEB_BASELINE ?? '.local/baseline/server');
  const load = file => import(pathToFileURL(join(baseline, 'dist', file)).href);
  const { createApp } = await load('app.js'), { openDatabase } = await load('database.js'), { parseRegistry } = await load('auth.js');
  const cases = resolve('.local/cases'); mkdirSync(cases, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(cases, 'web-001-'));
  const token = () => randomBytes(32).toString('hex');
  const config = { principals: [
    { id: 'web_device', owner_id: 'web_owner', kind: 'user', token: token() },
    { id: 'other_device', owner_id: 'other_owner', kind: 'user', token: token() },
    { id: 'fixture_source', owner_id: 'web_owner', kind: 'source', source_id: 'fixture_source', source_epoch: 'fixture_epoch', token: token(), capabilities: ['publish','read_responses','reply'] },
  ] };
  const db = openDatabase(join(root, 'events.sqlite'));
  const app = createApp(db, false, { registry: () => parseRegistry(config) });
  const requests = [];
  app.addHook('onRequest', async request => { requests.push({ method: request.method, path: request.url }); });
  await app.listen({ host: '127.0.0.1', port });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const userToken = config.principals[0].token, otherToken = config.principals[1].token, sourceToken = config.principals[2].token;
  const req = async (method, path, body, credential = sourceToken) => {
    const r = await fetch(origin + path, { method, headers: { Authorization: 'Bearer ' + credential, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error' });
    const data = await r.json(); if (r.status !== 200) throw new Error(`${r.status} ${data.error?.code}`); return data;
  };
  const create = async (title = '构建完成，需要你的选择', extra = {}) => {
    const body = { request_id: randomUUID(), title, body: '隔离来源已完成准备。请决定是否继续，或补充一条要求。', session_ref: 'synthetic_web_session', target_revision: 'fixture_revision', expires_at: '2099-01-01T00:00:00Z', interaction: { id: 'fixture_question', actions: [{ id: 'continue', label: '继续处理', type: 'button' }, { id: 'comment', label: '补充要求', type: 'text' }] }, ...extra };
    return req('POST', '/v1/events', body);
  };
  const update = async (eventId, body = '来源自报：已记录本轮选择。此夹具没有调用模型或原生执行。', extra = {}) => {
    const e = await req('GET', '/v1/events/' + eventId, undefined, userToken);
    return req('POST', '/v1/events/' + eventId + '/updates', { update_id: randomUUID(), expected_event_version: e.event_version, kind: 'source_result_reported', body, ...extra });
  };
  writeFileSync(join(root, 'credentials.json'), JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  return { root, db, app, origin, config, requests, userToken, otherToken, sourceToken, req, create, update, close: () => app.close() };
}
// Fault gateway is an isolated test process, not part of the product or backend.
export async function gateway(target) {
  const control = { fault: '', requests: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks), method = req.method;
    control.requests.push({ method, path: req.url });
    const r = await fetch(target + req.url, { method, headers: { Authorization: req.headers.authorization ?? '', ...(body.length ? { 'Content-Type': 'application/json' } : {}) }, body: body.length ? body : undefined, redirect: 'manual' });
    const bytes = Buffer.from(await r.arrayBuffer());
    const fault = method !== 'GET' ? control.fault : '';
    if (fault) control.fault = '';
    if (fault === 'drop') { req.socket.destroy(); return; }
    if (fault === 'json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{'); return; }
    if (fault === '503') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"STORAGE_FAILURE"}}'); return; }
    if (fault === 'redirect') { res.writeHead(307, { Location: target + '/v1/events' }); res.end(); return; }
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' }); res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { control, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
