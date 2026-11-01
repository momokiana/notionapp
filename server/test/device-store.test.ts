import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs, { chmodSync, mkdtempSync, readFileSync, renameSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ApiError } from '../src/auth.js';
import { DeviceStore, credentialHash, type InviteInput } from '../src/device-store.js';

const token = () => randomBytes(32).toString('hex');
const NOW = Date.parse('2026-01-01T00:00:00Z');
function setup(t: TestContext) {
  const root = mkdtempSync('/tmp/notifier-device-store-'); chmodSync(root, 0o700);
  const path = join(root, 'authority.sqlite'); const id = DeviceStore.initialize(path).store_id;
  let clock = NOW;
  const store = new DeviceStore(path, id, () => clock); t.after(() => store.close());
  const invite = (override: Partial<InviteInput> = {}) => {
    const value: InviteInput = { request_id: randomUUID(), invitation_id: randomUUID(), secret: token(), owner_id: 'owner', label: 'Phone', manage_devices: false, expires_at: NOW + 60000, ...override };
    store.createInvitation('operator', value); return value;
  };
  const claim = (override: Partial<InviteInput> = {}) => {
    const value = invite(override); const credential = token(); const claim_id = randomUUID();
    const result = store.claim({ claim_id, invitation_id: value.invitation_id, secret: value.secret, token: credential }, () => {});
    return { value, credential, claim_id, result, identity: store.authenticate(credential) };
  };
  return { root, path, id, store, invite, claim, time: (value: number) => { clock = value; } };
}
function rejects(action: () => unknown, code?: string) { assert.throws(action, e => e instanceof ApiError && (code === undefined || e.code === code)); }

test('device authority initializes once, reopens exact ID, and never changes event ledger schema', t => {
  const f = setup(t); assert.throws(() => DeviceStore.initialize(f.path));
  assert.throws(() => new DeviceStore(f.path, randomUUID()));
  const reopened = new DeviceStore(f.path, f.id); assert.deepEqual(reopened.list('owner'), []); reopened.close();
  const disk = new Database(f.path, { readonly: true }); t.after(() => disk.close());
  assert.equal(disk.pragma('user_version', { simple: true }), 1);
  assert.equal((disk.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='events'").get() as { n: number }).n, 0);
});

test('wrong permissions, symlinks, unrecognized schema, and replaced original inode fail closed', t => {
  const f = setup(t); const alias = join(f.root, 'alias.sqlite'); symlinkSync(f.path, alias);
  assert.throws(() => new DeviceStore(alias, f.id));
  chmodSync(f.path, 0o644); rejects(() => f.store.list('owner'), 'DEVICE_AUTHORITY_UNAVAILABLE'); chmodSync(f.path, 0o600);
  const writer = new Database(f.path); writer.exec('CREATE TABLE unrecognized(extra TEXT)'); writer.close();
  rejects(() => f.store.list('owner'), 'DEVICE_AUTHORITY_UNAVAILABLE');
  assert.throws(() => new DeviceStore(f.path, f.id));
  const other = setup(t); renameSync(other.path, join(other.root, 'preserved-original.sqlite'));
  const replacement = join(other.root, 'replacement.sqlite'); DeviceStore.initialize(replacement); renameSync(replacement, other.path);
  rejects(() => other.store.list('owner'), 'DEVICE_AUTHORITY_UNAVAILABLE');
});

test('orphan sidecars are preserved and never initialize a new identity around old unknown bytes', () => {
  const root = mkdtempSync('/tmp/notifier-device-orphan-'); chmodSync(root, 0o700); const path = join(root, 'authority.sqlite');
  fs.writeFileSync(path + '-wal', 'original-unknown-wal', { mode: 0o600 }); const original = readFileSync(path + '-wal');
  rejects(() => DeviceStore.initialize(path), 'DEVICE_AUTHORITY_UNAVAILABLE'); assert.equal(fs.existsSync(path), false); assert.deepEqual(readFileSync(path + '-wal'), original);
});

test('foreign DELETE-mode database is refused read-only with original bytes and mode unchanged', t => {
  const root = mkdtempSync('/tmp/notifier-device-foreign-'); chmodSync(root, 0o700);
  const path = join(root, 'foreign.sqlite'); const db = new Database(path); db.exec('CREATE TABLE foreign_fact(id TEXT); INSERT INTO foreign_fact VALUES(\'retain\')'); db.close(); chmodSync(path, 0o600);
  const original = readFileSync(path); assert.throws(() => new DeviceStore(path, randomUUID())); assert.deepEqual(readFileSync(path), original);
  const read = new Database(path, { readonly: true }); t.after(() => read.close()); assert.equal(read.pragma('journal_mode', { simple: true }), 'delete');
});

test('claim is atomic, same original body is idempotent and different claim/body cannot consume twice', t => {
  const f = setup(t); const invitation = f.invite(); const credential = token();
  const input = { claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, token: credential };
  const original = f.store.claim(input, () => {});
  assert.deepEqual(f.store.claim(input, () => { throw new Error('duplicate must return original fact'); }), original);
  rejects(() => f.store.claim({ ...input, claim_id: randomUUID() }, () => {}), 'PAIRING_ALREADY_USED');
  rejects(() => f.store.claim({ ...input, token: token() }, () => {}), 'PAIRING_ALREADY_USED');
  assert.equal(f.store.list('owner').length, 1); assert.equal(f.store.authenticate(credential).id, original.device_id);
  assert.equal(f.store.authenticate(credential).manage_devices, false);
});

test('expired or wrong pairing secret refuses without activating credentials', t => {
  const f = setup(t); const invitation = f.invite(); const credential = token();
  const input = { claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, token: credential };
  rejects(() => f.store.claim({ ...input, secret: token() }, () => {}), 'INVALID_PAIRING');
  f.time(NOW + 60000); rejects(() => f.store.claim(input, () => {}), 'PAIRING_EXPIRED');
  assert.equal(f.store.list('owner').length, 0); rejects(() => f.store.authenticate(credential), 'UNAUTHENTICATED');
});

test('claim proof survives expiry/revocation but cannot reactivate a revoked token', t => {
  const f = setup(t); const one = f.claim(); f.time(NOW + 600000);
  const body = { claim_id: one.claim_id, invitation_id: one.value.invitation_id, secret: one.value.secret, token: one.credential };
  assert.deepEqual(f.store.claim(body, () => {}), one.result);
  const request = randomUUID(); f.store.revoke(one.credential, request, one.identity.id);
  assert.deepEqual(f.store.claim(body, () => {}), one.result);
  rejects(() => f.store.authenticate(one.credential), 'UNAUTHENTICATED');
  assert.deepEqual(f.store.selfRevocationReceipt(one.credential, request), { request_id: request, device_id: one.identity.id, revoked: true });
  rejects(() => f.store.selfRevocationReceipt(one.credential, randomUUID()), 'NOT_FOUND');
});

test('current authentication precedes old operation receipt replay', t => {
  const f = setup(t); const manager = f.claim({ manage_devices: true }); const other = f.claim();
  const request = randomUUID(); f.store.revoke(manager.credential, request, other.identity.id);
  const self = randomUUID(); f.store.revoke(manager.credential, self, manager.identity.id);
  rejects(() => f.store.revoke(manager.credential, request, other.identity.id), 'UNAUTHENTICATED');
  rejects(() => f.store.selfRevocationReceipt(manager.credential, request), 'NOT_FOUND');
  assert.equal(f.store.selfRevocationReceipt(manager.credential, self).revoked, true);
});

test('rotate retains exact actor/owner and durable original transition, never returns old token to service', t => {
  const f = setup(t); const one = f.claim(); const replacement = token(); const request = randomUUID();
  const transition = f.store.rotate(one.credential, request, replacement, () => {});
  rejects(() => f.store.authenticate(one.credential), 'UNAUTHENTICATED');
  const current = f.store.authenticate(replacement); assert.equal(current.id, one.identity.id); assert.equal(current.owner_id, one.identity.owner_id); assert.equal(current.credential_version, 2);
  assert.equal(transition.from_hash, credentialHash(one.credential)); assert.equal(transition.to_hash, credentialHash(replacement));
  const reopened = new DeviceStore(f.path, f.id); t.after(() => reopened.close());
  assert.deepEqual(reopened.transition(replacement, request), transition);
  rejects(() => reopened.transition(one.credential, request), 'UNAUTHENTICATED');
  rejects(() => reopened.rotate(one.credential, request, replacement, () => {}), 'UNAUTHENTICATED');
  const again = token(); reopened.rotate(replacement, randomUUID(), again, () => {});
  rejects(() => reopened.transition(again, request), 'NOT_FOUND'); // no old-version proof used as current login
  assert.equal(reopened.authenticate(again).credential_version, 3);
});

test('same-owner normal phones have no implicit management and other-owner devices remain invisible', t => {
  const f = setup(t); const a = f.claim(); const b = f.claim(); const outsider = f.claim({ owner_id: 'other' });
  rejects(() => f.store.revoke(a.credential, randomUUID(), b.identity.id), 'FORBIDDEN');
  rejects(() => f.store.revoke(a.credential, randomUUID(), outsider.identity.id), 'NOT_FOUND');
  assert.equal(f.store.authenticate(b.credential).id, b.identity.id); assert.equal(f.store.list('owner').length, 2);
});

test('collision refusal and rollback after credential checker exception leave invite and old credential intact', t => {
  const f = setup(t); const one = f.claim(); const candidate = f.invite();
  const input = { claim_id: randomUUID(), invitation_id: candidate.invitation_id, secret: candidate.secret, token: token() };
  assert.throws(() => f.store.claim(input, () => { throw new Error('external static collision'); }));
  assert.equal(f.store.list('owner').length, 1);
  const result = f.store.claim(input, () => {}); assert.equal(f.store.authenticate(input.token).id, result.device_id);
  rejects(() => f.store.rotate(one.credential, randomUUID(), input.token, () => {}), 'CREDENTIAL_ALREADY_KNOWN');
  assert.equal(f.store.authenticate(one.credential).credential_version, 1);
});

test('async guards and async credential checks refuse before running asynchronous user code', t => {
  const f = setup(t); let effects = 0;
  rejects(() => f.store.guard(async () => { effects++; }), 'ASYNC_AUTHORITY_GATE_FORBIDDEN');
  const invitation = f.invite(); rejects(() => f.store.claim({ claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, token: token() }, async () => { effects++; }), 'ASYNC_AUTHORITY_GATE_FORBIDDEN');
  assert.equal(effects, 0); assert.equal(f.store.list('owner').length, 0);
});

for (const directory of [false, true]) {
  test(`original ${directory ? 'directory' : 'file'} sync EIO blocks readable authority and original claim until genuine recovery`, t => {
    const f = setup(t); const invitation = f.invite(); const input = { claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, token: token() };
    const original = fs.fsyncSync;
    fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory() === directory) throw Object.assign(new Error('synthetic original sync failure'), { code: 'EIO' }); original(fd); }; syncBuiltinESMExports();
    try {
      rejects(() => new DeviceStore(f.path, f.id), 'DEVICE_AUTHORITY_UNAVAILABLE');
      rejects(() => f.store.claim(input, () => {}), 'DEVICE_AUTHORITY_UNAVAILABLE');
    } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
    assert.equal(f.store.list('owner').length, 0);
    const result = f.store.claim(input, () => {}); assert.equal(f.store.authenticate(input.token).id, result.device_id);
  });
  test(`post-commit ${directory ? 'directory' : 'file'} sync EIO retains original rotation, does not refund or repeat it`, t => {
    const f = setup(t); const one = f.claim(); const replacement = token(); const request = randomUUID();
    const reader = new Database(f.path, { readonly: true }); t.after(() => reader.close());
    const original = fs.fsyncSync;
    fs.fsyncSync = fd => {
      if (fs.fstatSync(fd).isDirectory() === directory && reader.prepare('SELECT 1 FROM credentials WHERE hash=?').get(credentialHash(replacement))) throw Object.assign(new Error('synthetic post-commit EIO'), { code: 'EIO' });
      original(fd);
    }; syncBuiltinESMExports();
    try {
      rejects(() => f.store.rotate(one.credential, request, replacement, () => {}), 'DEVICE_AUTHORITY_UNAVAILABLE');
      rejects(() => f.store.authenticate(replacement), 'DEVICE_AUTHORITY_UNAVAILABLE');
    } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
    assert.equal(f.store.authenticate(replacement).credential_version, 2);
    assert.equal(f.store.transition(replacement, request).from_hash, credentialHash(one.credential));
    rejects(() => f.store.rotate(one.credential, request, replacement, () => {}), 'UNAUTHENTICATED');
    assert.equal((reader.prepare('SELECT COUNT(*) n FROM transitions').get() as { n: number }).n, 1);
  });
}

test('original WAL sync EIO is not mistaken for durable authority just because main file and parent can sync', t => {
  const f = setup(t); const one = f.claim(); const wal = fs.statSync(f.path + '-wal'); const original = fs.fsyncSync;
  fs.fsyncSync = fd => { const stat = fs.fstatSync(fd); if (stat.dev === wal.dev && stat.ino === wal.ino) throw Object.assign(new Error('synthetic original WAL EIO'), { code: 'EIO' }); original(fd); }; syncBuiltinESMExports();
  try { rejects(() => f.store.authenticate(one.credential), 'DEVICE_AUTHORITY_UNAVAILABLE'); }
  finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert.equal(f.store.authenticate(one.credential).id, one.identity.id);
});

test('device-capacity backpressure retains every original identity and does not consume an invitation or ACK a new actor', t => {
  const f = setup(t); const invitation = f.invite(); const tokenValue = token(); const writer = new Database(f.path); const insert = writer.prepare("INSERT INTO devices VALUES(?,?,?,0,'revoked',1,?)");
  writer.transaction(() => { for (let i=0;i<1000;i++) insert.run(`retained_${i}`, 'owner', 'Retained original', NOW); }).immediate();
  rejects(() => f.store.claim({ claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, token: tokenValue }, () => {}), 'DEVICE_AUTHORITY_FULL');
  assert.equal(f.store.list('owner').length, 1000); assert.equal((writer.prepare('SELECT claim_id FROM invitations WHERE id=?').get(invitation.invitation_id) as { claim_id: null }).claim_id, null); writer.close();
  rejects(() => f.store.authenticate(tokenValue), 'UNAUTHENTICATED');
});

test('only token digests are durable; strict boolean and duplicate invitation material reject', t => {
  const f = setup(t); const invitation = f.invite();
  rejects(() => f.store.createInvitation('operator', { ...invitation, request_id: randomUUID() }), 'INVITATION_ALREADY_KNOWN');
  rejects(() => f.store.createInvitation('operator', { ...invitation, request_id: randomUUID(), invitation_id: randomUUID(), manage_devices: 'false' as unknown as boolean }), 'INVALID_INPUT');
  const credential = token(); f.store.claim({ claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, token: credential }, () => {});
  const db = new Database(f.path, { readonly: true }); t.after(() => db.close());
  const content = JSON.stringify(['authority','devices','credentials','invitations','device_operations','transitions','handovers'].map(name => db.prepare(`SELECT * FROM ${name}`).all()));
  assert.equal(content.includes(invitation.secret), false); assert.equal(content.includes(credential), false);
  assert.equal(readFileSync(f.path).includes(Buffer.from(credential)), false);
});
