// Opt-in synthetic local fixture, no AI/SDK/model/push/device reports. Never operates ADB.
import { mkdtempSync, writeFileSync, appendFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../../server/dist/app.js';
import { openDatabase } from '../../server/dist/database.js';
import { fileRegistry } from '../../server/dist/auth.js';
if (process.env.NOTIONAPP_DRAFT_EMULATOR_FIXTURE !== '1') throw new Error('Explicit NOTIONAPP_DRAFT_EMULATOR_FIXTURE=1 required');
const root = mkdtempSync(join(tmpdir(), 'notifier-draft-emulator-')); chmodSync(root, 0o700);
const user = { id: 'phone', owner_id: 'fixture', kind: 'user', token: randomBytes(32).toString('hex') };
const source = { id: 'source_actor', owner_id: 'fixture', kind: 'source', source_id: 'draft_source', source_epoch: 'epoch_1', capabilities: ['publish', 'reply', 'read_responses'], token: randomBytes(32).toString('hex') };
const auth = join(root, 'auth.json'); writeFileSync(auth, JSON.stringify({ principals: [user, source] }), { mode: 0o600 });
const db = openDatabase(join(root, 'fixture.sqlite')); const app = createApp(db, false, { registry: fileRegistry(auth) });
app.addHook('onRequest', async request => {
  if (!request.headers['user-agent']?.startsWith('lightMyRequest')) appendFileSync(join(root, 'requests.jsonl'), JSON.stringify({ method: request.method, path: request.url, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
});
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const ids = [];
for (const kind of ['text', 'button']) {
  const result = await app.inject({ method: 'POST', url: '/v1/events', headers: { authorization: `Bearer ${source.token}` }, payload: {
    request_id: randomUUID(), title: kind === 'text' ? 'Offline draft question' : 'Offline button question', body: 'Synthetic question v1. Save locally while offline, then explicitly review current content.',
    session_ref: 'draft_fixture_only', target_revision: 'r1', expires_at: '2099-01-01T00:00:00Z',
    interaction: { id: `draft_${kind}`, actions: [{ id: 'reply', label: kind === 'text' ? 'Reply' : 'Continue', type: kind }] }
  } });
  if (result.statusCode !== 200) throw new Error(`Seed refused ${result.statusCode}`); ids.push(result.json().event_id);
}
writeFileSync(join(root, 'device-access.json'), JSON.stringify({ base: url, token: user.token, event_ids: ids }), { mode: 0o600 });
let advanced = false;
const timer = setInterval(async () => {
  if (advanced || !existsSync(join(root, 'advance.signal'))) return; advanced = true;
  const result = await app.inject({ method: 'POST', url: `/v1/events/${ids[0]}/updates`, headers: { authorization: `Bearer ${source.token}` }, payload: {
    update_id: randomUUID(), expected_event_version: 1, kind: 'progress', body: 'Current question v2. Review this changed body before confirming the original draft.'
  } });
  writeFileSync(join(root, 'advance-result.json'), JSON.stringify({ status: result.statusCode, result: result.json() }), { mode: 0o600 });
}, 200);
let closing = false;
async function stop() { if (closing) return; closing = true; clearInterval(timer); await app.close(); }
process.on('SIGTERM', () => { stop().catch(() => { process.exitCode = 1; }); });
process.on('SIGINT', () => { stop().catch(() => { process.exitCode = 1; }); });
console.log(JSON.stringify({ fixture: 'draft-emulator', private_root: root }));
