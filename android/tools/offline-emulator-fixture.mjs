// Explicit local-only fixture. No Pi/AI host, cloud, distributor registration or device receipts.
import { mkdtempSync, writeFileSync, appendFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../../server/dist/app.js';
import { openDatabase } from '../../server/dist/database.js';
import { fileRegistry } from '../../server/dist/auth.js';
if (process.env.NOTIONAPP_OFFLINE_EMULATOR_FIXTURE !== '1') throw new Error('Explicit NOTIONAPP_OFFLINE_EMULATOR_FIXTURE=1 required');
const root = mkdtempSync(join(tmpdir(), 'notifier-offline-emulator-')); chmodSync(root, 0o700);
const auth = join(root, 'auth.json');
const user = { id: 'phone', owner_id: 'fixture', kind: 'user', token: randomBytes(32).toString('hex') };
const source = { id: 'source_actor', owner_id: 'fixture', kind: 'source', source_id: 'offline_source', source_epoch: 'epoch_1', capabilities: ['publish', 'reply', 'read_responses'], token: randomBytes(32).toString('hex') };
writeFileSync(auth, JSON.stringify({ principals: [user, source] }), { mode: 0o600 });
const db = openDatabase(join(root, 'fixture.sqlite'));
const app = createApp(db, false, { registry: fileRegistry(auth) });
// No headers, bodies or credentials in this diagnostic log; source injects are not device traffic.
app.addHook('onRequest', async request => { if (!request.headers['user-agent']?.startsWith('lightMyRequest')) appendFileSync(join(root, 'requests.jsonl'), JSON.stringify({ method: request.method, path: request.url, at: new Date().toISOString() }) + '\n', { mode: 0o600 }); });
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const ids = [];
for (let n = 1; n <= 51; n++) {
  const result = await app.inject({ method: 'POST', url: '/v1/events', headers: { authorization: `Bearer ${source.token}` }, payload: {
    request_id: randomUUID(), title: n === 1 ? 'Offline cached question' : `Cache fixture ${String(n).padStart(3, '0')}`,
    body: n === 1 ? 'Cached body v1. 中文与表情🙂，离线原文。' : `Read-only offline fixture ${n}`,
    session_ref: 'offline_only', target_revision: 'r1', expires_at: '2099-01-01T00:00:00Z',
    ...(n === 1 ? { interaction: { id: 'offline_question', actions: [{ id: 'go', label: 'Do not submit in cache test', type: 'button' }] } } : {})
  } });
  if (result.statusCode !== 200) throw new Error(`Seed refused ${result.statusCode}`);
  ids.push(result.json().event_id);
}
writeFileSync(join(root, 'device-access.json'), JSON.stringify({ base: url, token: user.token, event_id: ids[0] }), { mode: 0o600 });
writeFileSync(join(root, 'seed.json'), JSON.stringify({ event_count: ids.length, event_ids: ids, model_requests: 0 }), { mode: 0o600 });
let advanced = false;
const timer = setInterval(async () => {
  if (advanced || !existsSync(join(root, 'advance.signal'))) return;
  advanced = true;
  const result = await app.inject({ method: 'POST', url: `/v1/events/${ids[0]}/updates`, headers: { authorization: `Bearer ${source.token}` }, payload: { update_id: randomUUID(), expected_event_version: 1, kind: 'progress', body: 'Reconnected body v2. 中文与表情🙂，原事件更新。' } });
  writeFileSync(join(root, 'advance-result.json'), JSON.stringify({ status: result.statusCode, result: result.json() }), { mode: 0o600 });
}, 200);
let closing = false;
async function stop() { if (closing) return; closing = true; clearInterval(timer); await app.close(); }
process.on('SIGTERM', () => { stop().catch(() => { process.exitCode = 1; }); });
process.on('SIGINT', () => { stop().catch(() => { process.exitCode = 1; }); });
console.log(JSON.stringify({ fixture: 'offline-emulator', private_root: root }));
