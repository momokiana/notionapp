import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { chmodSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseRegistry } from '../src/auth.js';
import { openDatabase } from '../src/database.js';
import { CoreStore } from '../src/core.js';
import { NotificationStore, type Notice, pushConfig } from '../src/notifications.js';
import { DeviceStore } from '../src/device-store.js';
import { DeviceAuthority } from '../src/device-authority.js';
import { credentials, eventInput, NOW } from './helpers.js';

function fixture(t: TestContext) {
  const root = mkdtempSync('/tmp/notifier-device-notices-'); chmodSync(root, 0o700); const path = join(root, 'authority.sqlite'); const id = DeviceStore.initialize(path).store_id;
  const store = new DeviceStore(path, id); const config = credentials(); const authority = new DeviceAuthority(store, () => parseRegistry(config)); const db = openDatabase(join(root, 'ledger.sqlite')); const core = new CoreStore(db, () => NOW);
  t.after(() => { db.close(); store.close(); });
  const notices = new NotificationStore(db, authority.registry, pushConfig('https://push.example.test'), () => NOW);
  const phone = () => {
    const invitation = { request_id: randomUUID(), invitation_id: randomUUID(), secret: randomBytes(32).toString('hex'), owner_id: 'owner', label: 'Notice phone', manage_devices: false, expires_at: Date.now() + 60000 };
    store.createInvitation('operator', invitation); const token = randomBytes(32).toString('hex'); const claim = store.claim({ claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, token }, authority.assertTokenAvailable);
    const p = authority.registry().authenticate(`Bearer ${token}`); notices.register(p, { registration_id: randomUUID(), expected_generation: 0, endpoint: `https://push.example.test/topic_${claim.device_id}` }); return { token, id: claim.device_id, p };
  };
  const source = config.principals.find(p => p.kind === 'source')!;
  const create = () => core.create(authority.registry().authenticate(`Bearer ${source.token}`), eventInput());
  const rows = () => db.prepare('SELECT * FROM notifications ORDER BY seq').all() as Notice[];
  return { store, path, db, phone, notices, create, rows };
}

test('managed notice audience/claim excludes one revoked actor without repointing the other actor or old unknown delivery', t => {
  const f = fixture(t); const a = f.phone(); const b = f.phone(); const original = f.create(); const first = f.notices.claim()!;
  assert.ok(first); const revoked = first.actor === a.id ? b : a; const current = first.actor === a.id ? a : b;
  f.store.operatorRevoke('owner', revoked.id, randomUUID()); assert.equal(f.notices.claim(), null);
  const before = f.rows(); assert.equal(before.find(n => n.id === first.id)!.platform_state, 'effect_unknown'); assert.equal(before.find(n => n.actor === revoked.id)!.platform_state, 'withheld');
  const next = f.create(); const delivery = f.notices.claim()!; assert.equal(delivery.actor, current.id); assert.equal(delivery.event_id, next.event_id); assert.equal(delivery.generation, 1);
  assert.equal(f.rows().some(n => n.actor === revoked.id && n.event_id === next.event_id), false);
  assert.equal(f.rows().filter(n => n.event_id === original.event_id).length, 2); assert.equal(f.rows().find(n => n.id === first.id)!.nonce, first.nonce);
});

test('revocation after the reserved unknown publish boundary does not falsify later original platform result or retry it', t => {
  const f = fixture(t); const a = f.phone(); f.create(); const original = f.notices.claim()!;
  f.store.operatorRevoke('owner', a.id, randomUUID()); f.notices.platform(original.id, 'platform_accepted');
  assert.equal(f.notices.claim(), null); assert.equal(f.rows().length, 1); assert.equal(f.rows()[0]!.platform_state, 'platform_accepted'); assert.equal(f.rows()[0]!.nonce, original.nonce);
});

test('configured auth failure blocks the original consumer claim before unknown publication and resumes only its original ledger intent', t => {
  const f = fixture(t); const a = f.phone(); const event = f.create(); chmodSync(f.path, 0o644);
  assert.throws(() => f.notices.claim()); assert.equal(f.rows().length, 0);
  chmodSync(f.path, 0o600); const recovered = f.notices.claim()!; assert.equal(recovered.event_id, event.event_id); assert.equal(recovered.actor, a.id); assert.equal(f.rows().length, 1);
});
