// Explicit owned-AVD device lifecycle fixture. Real private ntfy/HTTP/SQLite, no SDK/model host and no fabricated device/OS receipts.
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createApp } from '../../server/dist/app.js';
import { openDatabase } from '../../server/dist/database.js';
import { fileRegistry } from '../../server/dist/auth.js';
import { DeviceStore } from '../../server/dist/device-store.js';
import { DeviceAuthority } from '../../server/dist/device-authority.js';
import { pushConfig } from '../../server/dist/notifications.js';
import { realNtfy } from '../../pi-host/test/real-ntfy.ts';
process.umask(0o077);
if (process.env.NOTIONAPP_DEVICE_FIXTURE !== '1' || process.argv.length !== 3) throw new Error('Explicit NOTIONAPP_DEVICE_FIXTURE=1 and verified absolute ntfy binary required');
const root = mkdtempSync(join(tmpdir(), 'notifier-device-emulator-'));
const auth = join(root, 'auth.json');
const source = { id: 'device_source_actor', owner_id: 'device_fixture', kind: 'source', source_id: 'device_source', source_epoch: 'epoch_1', capabilities: ['publish','reply','read_responses'], token: randomBytes(32).toString('hex') };
writeFileSync(auth, JSON.stringify({ principals: [source] }), { mode: 0o600 });
const authorityPath = join(root, 'authority.sqlite'); const storeId = DeviceStore.initialize(authorityPath).store_id;
const devices = new DeviceStore(authorityPath, storeId); const authority = new DeviceAuthority(devices, fileRegistry(auth));
const sourceIds = Array.from({ length: 20 }, () => randomUUID()); writeFileSync(join(root, 'source-operations.json'), JSON.stringify(sourceIds), { mode: 0o600 });
let stopping = false; process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
const ntfy = await realNtfy(process.argv[2]!, true); let app: ReturnType<typeof createApp> | undefined;
try {
  const db = openDatabase(join(root, 'ledger.sqlite'));
  app = createApp(db, false, { deviceAuthority: authority, push: pushConfig(ntfy.origin, ntfy.token, true) });
  const dropped = new Set<string>();
  app.addHook('onSend', async (request, reply, payload) => {
    const name = request.method !== 'POST' || reply.statusCode !== 200 ? undefined : request.url === '/v1/pairing/claim' ? 'pair' : request.url === '/v1/device/rotate' ? 'rotate' : request.url === '/v1/device/revoke' ? 'revoke' : /^\/v1\/events\/[A-Za-z0-9_-]+\/responses$/.test(request.url) ? 'response' : undefined;
    if (name && !dropped.has(name) && existsSync(join(root, `drop-${name}.signal`))) {
      dropped.add(name); const body = request.body as Record<string, unknown>;
      writeFileSync(join(root, `${name}-ack-lost.json`), JSON.stringify({ route: request.url, id: body.claim_id ?? body.request_id ?? body.response_id, after_durable_handler_before_ack: true }), { mode: 0o600 });
      request.raw.socket.destroy();
    }
    return payload;
  });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const packages = Array.from({ length: 2 }, (_, index) => {
    const pkg = { notifier_pairing: 1, base, store_id: storeId, invitation_id: randomUUID(), secret: randomBytes(32).toString('hex'), expires_at: Date.now() + 15 * 60 * 1000, owner_id: source.owner_id, label: index === 0 ? 'Owned AVD primary' : 'Owned second device', manage_devices: index === 0 };
    devices.createInvitation('operator', { request_id: pkg.invitation_id, invitation_id: pkg.invitation_id, secret: pkg.secret, expires_at: pkg.expires_at, owner_id: pkg.owner_id, label: pkg.label, manage_devices: pkg.manage_devices }); return pkg;
  });
  writeFileSync(join(root, 'operator-private.json'), JSON.stringify({ base, packages, ntfy_origin: ntfy.origin, subscriber: ntfy.subscriber }), { mode: 0o600 });
  console.log(JSON.stringify({ fixture: 'device-lifecycle', private_root: root, model_host: false }));
  const headers = { authorization: `Bearer ${source.token}` }; let eventId: string | undefined; let step = 0;
  while (!stopping) {
    const next = step + 1;
    if (next <= sourceIds.length && existsSync(join(root, `step-${next}.signal`))) {
      const record = join(root, `source-step-${next}-intent.json`);
      if (existsSync(record)) throw new Error('Original source step already attempted; inspect it rather than create another request');
      const current = eventId ? JSON.parse((db.prepare('SELECT data FROM events WHERE id=?').get(eventId) as { data: string }).data).event_version as number : 0;
      const interaction = { id: `question_${next}`, actions: [{ id: 'confirm', label: '保存原回应', type: 'button' }, { id: 'reply', label: '输入测试文字', type: 'text' }] };
      const body = eventId ? { update_id: sourceIds[step], expected_event_version: current, kind: 'progress', body: `PRIVATE T010 step ${next}. Only open inside the App.`, interaction } : { request_id: sourceIds[step], title: 'PRIVATE T010 设备生命周期', body: '隔离自托管配对测试。不是澪，也没有模型调用。', session_ref: 'device_fixture_session', target_revision: 'r1', expires_at: '2099-01-01T00:00:00Z', interaction };
      const url = eventId ? `/v1/events/${eventId}/updates` : '/v1/events'; writeFileSync(record, JSON.stringify({ url, body }), { mode: 0o600 });
      const response = await app.inject({ method: 'POST', url, headers, payload: body });
      writeFileSync(join(root, `source-step-${next}-result.json`), JSON.stringify({ status: response.statusCode, result: response.json() }), { mode: 0o600 });
      if (response.statusCode !== 200) throw new Error('Original source step unresolved or refused; no automatic retry'); eventId ??= response.json().event_id; step = next;
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    writeFileSync(join(root, 'observation-private.json'), JSON.stringify({ event_id: eventId, source_steps: step,
      devices: devices.list(source.owner_id).map(d => ({ id: d.id, label: d.label, state: d.state, credential_version: d.credential_version })),
      push: (db.prepare('SELECT actor,generation,registration_id,endpoint FROM push_devices').all() as { actor: string; generation: number; registration_id: string; endpoint: string | null }[]).map(d => ({ actor: d.actor, generation: d.generation, registration_id: d.registration_id, endpoint_hash: d.endpoint ? hash(d.endpoint) : null })),
      notifications: db.prepare('SELECT id,actor,event_id,version,generation,platform_state,device_received_at,notification_posted_at FROM notifications ORDER BY seq').all(),
      responses: db.prepare('SELECT id,event_id FROM responses').all(), read_states: db.prepare('SELECT * FROM read_states').all(), model_host: false }), { mode: 0o600 });
    await new Promise(resolve => setTimeout(resolve, 300));
  }
} finally { await app?.close(); devices.close(); await ntfy.close(); console.log(JSON.stringify({ stopped: true, original_data_retained: true })); }
