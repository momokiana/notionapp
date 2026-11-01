// Real local ntfy + product HTTP service, no AI host or manufactured Android receipts.
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { createApp } from '../../server/dist/app.js';
import { openDatabase } from '../../server/dist/database.js';
import { fileRegistry } from '../../server/dist/auth.js';
import { pushConfig, payloadFor, type Notice } from '../../server/dist/notifications.js';
import { realNtfy } from '../../pi-host/test/real-ntfy.ts';
process.umask(0o077);
if (process.env.NOTIONAPP_NOTICE_FIXTURE !== '1' || process.argv.length !== 3) throw new Error('Explicit NOTIONAPP_NOTICE_FIXTURE=1 and verified absolute ntfy binary required');
const root = mkdtempSync('/tmp/notifier-notice-emulator-');
const auth = join(root, 'auth.json');
const user = { id: 'phone', owner_id: 'notice_fixture', kind: 'user', token: randomBytes(32).toString('hex') };
const source = { id: 'notice_source_actor', owner_id: user.owner_id, kind: 'source', source_id: 'notice_source', source_epoch: 'epoch_1', capabilities: ['publish', 'reply', 'read_responses'], token: randomBytes(32).toString('hex') };
writeFileSync(auth, JSON.stringify({ principals: [user, source] }), { mode: 0o600 });
let stopping = false;
process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
const ntfy = await realNtfy(process.argv[2]!, true);
let app: ReturnType<typeof createApp> | undefined;
try {
  const db = openDatabase(join(root, 'fixture.sqlite'));
  app = createApp(db, false, { registry: fileRegistry(auth), push: pushConfig(ntfy.origin, ntfy.token, true) });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  writeFileSync(join(root, 'operator-private.json'), JSON.stringify({ base, token: user.token, ntfy_origin: ntfy.origin, subscriber: ntfy.subscriber }), { mode: 0o600 });
  console.log(JSON.stringify({ fixture: 'notice-preferences', private_root: root, model_host: false }));
  let id: string | undefined; let version = 0; let replayed = false;
  const updates = Array.from({ length: 20 }, () => randomUUID());
  // Persist source operation IDs once, never generate replacements on an unknown outcome.
  writeFileSync(join(root, 'source-operations.json'), JSON.stringify(updates), { mode: 0o600 });
  const headers = { authorization: `Bearer ${source.token}` };
  while (!stopping) {
    const requested = version + 1;
    if (requested <= 20 && existsSync(join(root, `step-${requested}.signal`))) {
      const result = id === undefined
        ? await app.inject({ method: 'POST', url: '/v1/events', headers, payload: { request_id: updates[0], title: 'PRIVATE notification title', body: 'PRIVATE notification body. Never appear on the lock screen.', session_ref: 'notice_isolated', target_revision: 'r1', expires_at: '2099-01-01T00:00:00Z' } })
        : await app.inject({ method: 'POST', url: `/v1/events/${id}/updates`, headers, payload: { update_id: updates[version], expected_event_version: version, kind: 'progress', body: `PRIVATE updated notification body v${requested}. Must remain inside App.` } });
      writeFileSync(join(root, `step-${requested}-result.json`), JSON.stringify({ status: result.statusCode, result: result.json() }), { mode: 0o600 });
      if (result.statusCode !== 200) throw new Error('Original source operation unresolved/refused; fixture will not retry');
      id ??= result.json().event_id; version = requested;
    }
    if (!replayed && existsSync(join(root, 'replay-v3.signal'))) {
      replayed = true;
      const notice = db.prepare('SELECT * FROM notifications WHERE event_id=? AND version=3').get(id) as Notice | undefined;
      if (!notice || notice.platform_state !== 'platform_accepted' || !notice.device_received_at) throw new Error('Original v3 platform/device receipt required; no new delivery will be created');
      const result = await fetch(notice.endpoint, { method: 'POST', body: JSON.stringify(payloadFor(notice)), headers: { authorization: `Bearer ${ntfy.token}`, 'content-type': 'application/octet-stream', 'x-unifiedpush': '1' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      await result.body?.cancel(); writeFileSync(join(root, 'replay-result.json'), JSON.stringify({ status: result.status }), { mode: 0o600 });
      if (!result.ok) throw new Error('Original transport replay unresolved; not retried');
    }
    writeFileSync(join(root, 'observation-private.json'), JSON.stringify({ event_id: id, version, devices: db.prepare('SELECT generation,endpoint FROM push_devices').all(), notifications: db.prepare('SELECT version,platform_state,device_received_at,notification_posted_at FROM notifications ORDER BY seq').all(), responses: db.prepare('SELECT COUNT(*) AS n FROM responses').get(), read_states: db.prepare('SELECT COUNT(*) AS n FROM read_states').get(), model_host: false }), { mode: 0o600 });
    await new Promise(resolve => setTimeout(resolve, 300));
  }
} finally {
  await app?.close(); await ntfy.close();
  console.log(JSON.stringify({ stopped: true, original_data_retained: true }));
}
