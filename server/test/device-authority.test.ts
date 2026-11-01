import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { chmodSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError, parseRegistry } from '../src/auth.js';
import { DeviceStore, type InviteInput } from '../src/device-store.js';
import { DeviceAuthority } from '../src/device-authority.js';
import { credentials } from './helpers.js';

const token = () => randomBytes(32).toString('hex');
const header = (value: string) => `Bearer ${value}`;
function fixture(t: TestContext) {
  const root = mkdtempSync('/tmp/notifier-device-authority-'); chmodSync(root, 0o700);
  const path = join(root, 'authority.sqlite'); const id = DeviceStore.initialize(path).store_id;
  const store = new DeviceStore(path, id); t.after(() => store.close());
  const config = credentials(); const authority = new DeviceAuthority(store, () => parseRegistry(config));
  const invite = (override: Partial<InviteInput> = {}) => ({ request_id: randomUUID(), invitation_id: randomUUID(), secret: token(), owner_id: 'owner', label: 'Phone', manage_devices: false, expires_at: Date.now() + 60000, ...override });
  const claim = (override: Partial<InviteInput> = {}) => {
    const input = invite(override); store.createInvitation('operator', input); const credential = token();
    const result = store.claim({ claim_id: randomUUID(), invitation_id: input.invitation_id, secret: input.secret, token: credential }, authority.assertTokenAvailable);
    return { credential, result, identity: store.authenticate(credential) };
  };
  return { path, id, store, config, authority, invite, claim };
}
function rejects(action: () => unknown, code: string) { assert.throws(action, e => e instanceof ApiError && e.code === code); }

test('composed registry preserves static source binding and requires explicit same-owner management', t => {
  const f = fixture(t); const manager = f.claim({ manage_devices: true }); const ordinary = f.claim();
  const registry = f.authority.registry(); const source = f.config.principals.find(p => p.kind === 'source')!;
  assert.deepEqual(registry.authenticate(header(source.token)), parseRegistry(f.config).authenticate(header(source.token)));
  assert.deepEqual(registry.source(source.owner_id, source.source_id!, source.source_epoch!), parseRegistry(f.config).source(source.owner_id, source.source_id!, source.source_epoch!));
  f.authority.invite(header(manager.credential), f.invite());
  rejects(() => f.authority.invite(header(ordinary.credential), f.invite()), 'FORBIDDEN');
  rejects(() => f.authority.invite(header(manager.credential), f.invite({ owner_id: 'other' })), 'FORBIDDEN');
  rejects(() => f.authority.invite(header(source.token), f.invite()), 'UNAUTHENTICATED');
});

test('static source/user token collision cannot claim an invitation or be reinterpreted as a device', t => {
  const f = fixture(t); const input = f.invite(); f.store.createInvitation('operator', input);
  for (const p of f.config.principals) rejects(() => f.store.claim({ claim_id: randomUUID(), invitation_id: input.invitation_id, secret: input.secret, token: p.token }, f.authority.assertTokenAvailable), 'CREDENTIAL_ALREADY_KNOWN');
  assert.equal(f.store.list('owner').length, 0);
  const credential = token(); f.store.claim({ claim_id: randomUUID(), invitation_id: input.invitation_id, secret: input.secret, token: credential }, f.authority.assertTokenAvailable);
  assert.equal(f.authority.registry().authenticate(header(credential)).kind, 'user');
});

test('unit seam: cached principal and registry never authorize a user write or audience after revocation', t => {
  const f = fixture(t); const a = f.claim(); const manager = f.claim({ manage_devices: true }); const cached = f.authority.registry();
  const expected = cached.authenticate(header(a.credential)); let effects = 0;
  f.authority.userWrite(header(a.credential), expected, () => { effects++; });
  const second = new DeviceStore(f.path, f.id); t.after(() => second.close());
  second.revoke(manager.credential, randomUUID(), a.identity.id);
  rejects(() => f.authority.userWrite(header(a.credential), expected, () => { effects++; }), 'UNAUTHENTICATED');
  assert.equal(cached.user(a.identity.owner_id, a.identity.id), undefined); assert.equal(effects, 1);
  // This is a synchronous seam unit test, NOT the separately required C05 HTTP/multiprocess race.
});

test('configured original store failure never falls back to static credentials, even for a cached registry', t => {
  const f = fixture(t); const cached = f.authority.registry(); const source = f.config.principals.find(p => p.kind === 'source')!;
  chmodSync(f.path, 0o644);
  rejects(() => cached.authenticate(header(source.token)), 'DEVICE_AUTHORITY_UNAVAILABLE');
  rejects(() => cached.source(source.owner_id, source.source_id!, source.source_epoch!), 'DEVICE_AUTHORITY_UNAVAILABLE');
  chmodSync(f.path, 0o600);
  assert.equal(cached.authenticate(header(source.token)).kind, 'source');
});

test('same actor with conflicting static source identity fails rather than choosing a role', t => {
  const f = fixture(t); const a = f.claim(); const source = f.config.principals.find(p => p.kind === 'source')!; source.id = a.identity.id;
  rejects(() => f.authority.registry().authenticate(header(source.token)), 'DEVICE_IDENTITY_CONFLICT');
  rejects(() => f.authority.registry().authenticate(header(a.credential)), 'DEVICE_IDENTITY_CONFLICT');
  rejects(() => f.authority.registry().user(a.identity.owner_id, a.identity.id), 'DEVICE_IDENTITY_CONFLICT');
  rejects(() => f.authority.registry().source(source.owner_id, source.source_id!, source.source_epoch!), 'DEVICE_IDENTITY_CONFLICT');
});

test('managed composition refuses a static provider without explicit actor collision lookup', t => {
  const f = fixture(t); const base = parseRegistry(f.config);
  const authority = new DeviceAuthority(f.store, () => ({ authenticate: base.authenticate, user: base.user, source: base.source }));
  rejects(() => authority.registry(), 'DEVICE_AUTHORITY_UNAVAILABLE');
});

test('user gate rejects async callback before its prefix can create an effect', t => {
  const f = fixture(t); const a = f.claim(); const expected = f.authority.registry().authenticate(header(a.credential)); let effects = 0;
  rejects(() => f.authority.userWrite(header(a.credential), expected, async () => { effects++; }), 'ASYNC_AUTHORITY_GATE_FORBIDDEN'); assert.equal(effects, 0);
});
