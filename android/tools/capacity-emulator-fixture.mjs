// New synthetic loopback dataset only. No model, Pi, push, ADB operation or device/source receipt.
import { mkdtempSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../../server/dist/app.js';
import { openDatabase } from '../../server/dist/database.js';
import { fileRegistry } from '../../server/dist/auth.js';
if (process.env.NOTIONAPP_CAPACITY_EMULATOR_FIXTURE !== '1') throw new Error('Explicit NOTIONAPP_CAPACITY_EMULATOR_FIXTURE=1 required');
const root = mkdtempSync(join(tmpdir(), 'notifier-capacity-emulator-')); chmodSync(root, 0o700);
const user = { id: 'phone', owner_id: 'fixture', kind: 'user', token: randomBytes(32).toString('hex') };
const source = { id: 'source_actor', owner_id: 'fixture', kind: 'source', source_id: 'capacity_source', source_epoch: 'epoch_1', capabilities: ['publish', 'reply', 'read_responses'], token: randomBytes(32).toString('hex') };
const auth = join(root, 'auth.json'); writeFileSync(auth, JSON.stringify({ principals: [user, source] }), { mode: 0o600 });
const app = createApp(openDatabase(join(root, 'fixture.sqlite')), false, { registry: fileRegistry(auth) });
app.addHook('onRequest', async request => {
  if (!request.headers['user-agent']?.startsWith('lightMyRequest')) appendFileSync(join(root, 'requests.jsonl'), JSON.stringify({ method: request.method, path: request.url, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
});
const url = await app.listen({ host: '127.0.0.1', port: 0 });
// Persist every original source request before even local inject. Interrupted setup is evidence, not completion.
const inputs = Array.from({ length: 1051 }, (_, n) => ({
  request_id: randomUUID(), title: n === 0 ? 'Capacity first question' : `Capacity event ${String(n + 1).padStart(4, '0')}`,
  body: `Synthetic capacity record ${n + 1}. Offline windows are not an update subscription.`,
  session_ref: 'capacity_fixture_only', target_revision: 'r1', expires_at: '2099-01-01T00:00:00Z',
  ...(n === 0 ? { interaction: { id: 'capacity_question', actions: [{ id: 'reply', label: 'Reply', type: 'text' }] } } : {})
}));
writeFileSync(join(root, 'source-intents.json'), JSON.stringify(inputs), { mode: 0o600 });
const ids = [];
try {
  for (const payload of inputs) {
    const result = await app.inject({ method: 'POST', url: '/v1/events', headers: { authorization: `Bearer ${source.token}` }, payload });
    appendFileSync(join(root, 'seed-results.jsonl'), JSON.stringify({ request_id: payload.request_id, status: result.statusCode, result: result.json() }) + '\n', { mode: 0o600 });
    if (result.statusCode !== 200) throw new Error('Synthetic capacity seed refused'); ids.push(result.json().event_id);
  }
  writeFileSync(join(root, 'device-access.json'), JSON.stringify({ base: url, token: user.token, event_ids: ids }), { mode: 0o600 });
  console.log(JSON.stringify({ fixture: 'capacity-emulator', private_root: root }));
} catch (error) { await app.close(); throw error; }
let closing = false;
async function stop() { if (closing) return; closing = true; await app.close(); }
process.on('SIGTERM', () => { stop().catch(() => { process.exitCode = 1; }); });
process.on('SIGINT', () => { stop().catch(() => { process.exitCode = 1; }); });
