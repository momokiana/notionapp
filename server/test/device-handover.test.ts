import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError, fileRegistry } from '../src/auth.js';
import { DeviceStore, credentialHash } from '../src/device-store.js';
import { DeviceAuthority } from '../src/device-authority.js';
import { handoverStaticUser, inspectStaticRegistry, type HandoverPhase } from '../src/device-handover.js';

function fixture(t: TestContext) {
  const root = mkdtempSync('/tmp/notifier-handover-'); chmodSync(root, 0o700); const registryDir = join(root, 'registry'); mkdirSync(registryDir, { mode: 0o700 });
  const path = join(root, 'authority.sqlite'); const id = DeviceStore.initialize(path).store_id; const store = new DeviceStore(path, id); t.after(() => store.close());
  const user = { id: 'phone', owner_id: 'owner', kind: 'user', token: randomBytes(32).toString('hex') };
  const source = { id: 'source', owner_id: 'owner', kind: 'source', token: randomBytes(32).toString('hex'), source_id: 'source', source_epoch: 'epoch_1', capabilities: ['publish','read_responses','reply','deliver'] };
  const other = { id: 'foreign_phone', owner_id: 'other', kind: 'user', token: randomBytes(32).toString('hex') };
  const auth = join(registryDir, 'static.json'); writeFileSync(auth, JSON.stringify({ principals: [user,source,other] }), { mode: 0o600 }); const original = readFileSync(auth);
  const request = { request_id: randomUUID(), device_id: user.id, owner_id: user.owner_id, label: 'Migrated phone', manage_devices: false, old_hash: credentialHash(user.token), registry_path: auth, original_digest: inspectStaticRegistry(auth).registry_digest };
  const intent = join(root, 'original-handover.json'); const authority = new DeviceAuthority(store, fileRegistry(auth, true));
  return { root, registryDir, store, auth, user, source, other, original, request, intent, authority };
}
function rejects(action: () => unknown, code?: string) { assert.throws(action, e => e instanceof ApiError && (code === undefined || e.code === code)); }
function untouched(f: ReturnType<typeof fixture>) {
  const remaining = JSON.parse(readFileSync(f.auth, 'utf8')).principals;
  assert.deepEqual(remaining.find((p: { id: string }) => p.id === f.source.id), f.source); assert.deepEqual(remaining.find((p: { id: string }) => p.id === f.other.id), f.other);
}

for (const phase of ['intent_saved','prepared','file_replaced','file_synced','activated'] as HandoverPhase[]) {
  test(`handover throw at ${phase} resumes only exact original operation and never confirms a static escape window`, t => {
    const f = fixture(t);
    const interrupt = () => handoverStaticUser(f.store, f.request, f.intent, true, at => { if (at === phase) throw new Error('synthetic boundary interruption'); });
    if (phase === 'file_replaced') rejects(interrupt, 'DEVICE_AUTHORITY_UNAVAILABLE'); else assert.throws(interrupt, /synthetic boundary/);
    if (phase === 'prepared' || phase === 'file_replaced' || phase === 'file_synced') {
      assert.equal(f.store.device(f.user.id)!.state, 'handover_pending');
      rejects(() => f.store.operatorRevoke('owner', f.user.id, randomUUID()), 'HANDOVER_UNRESOLVED');
      rejects(() => f.authority.registry().authenticate(`Bearer ${f.user.token}`), 'UNAUTHENTICATED');
    }
    if (phase === 'file_replaced' || phase === 'file_synced' || phase === 'activated') rejects(() => fileRegistry(f.auth)().authenticate(`Bearer ${f.user.token}`), 'UNAUTHENTICATED');
    const result = handoverStaticUser(f.store, f.request, f.intent, true); assert.equal(result.handover_completed, true); assert.equal(result.device_id, f.user.id);
    assert.equal(f.authority.registry().authenticate(`Bearer ${f.user.token}`).id, f.user.id); assert.equal(f.store.authenticate(f.user.token).credential_version, 1);
    rejects(() => fileRegistry(f.auth)().authenticate(`Bearer ${f.user.token}`), 'UNAUTHENTICATED'); untouched(f);
    const originalIntent = readFileSync(f.intent); f.store.operatorRevoke('owner', f.user.id, randomUUID());
    const old = handoverStaticUser(f.store, f.request, f.intent, true); assert.equal(old.current_state, 'revoked'); assert.equal(old.historical_completion, true);
    rejects(() => f.authority.registry().authenticate(`Bearer ${f.user.token}`), 'UNAUTHENTICATED'); assert.deepEqual(readFileSync(f.intent), originalIntent); untouched(f);
  });
}

test('handover refuses source identity, wrong owner, wrong old digest and absent exclusive writer control without altering original file', t => {
  const f = fixture(t);
  for (const request of [{ ...f.request, device_id: f.source.id, old_hash: credentialHash(f.source.token) }, { ...f.request, owner_id: 'other' }, { ...f.request, old_hash: credentialHash('wrong') }]) {
    rejects(() => handoverStaticUser(f.store, request, f.intent, true), 'HANDOVER_ORIGINAL_IDENTITY_MISMATCH'); assert.deepEqual(readFileSync(f.auth), f.original);
  }
  rejects(() => handoverStaticUser(f.store, f.request, f.intent, false), 'EXCLUSIVE_REGISTRY_CONTROL_REQUIRED'); assert.equal(f.store.list('owner').length, 0);
});

test('observed other-writer conflict never overwrites source changes or activates a partial identity', t => {
  const f = fixture(t); let changed: Buffer | undefined;
  rejects(() => handoverStaticUser(f.store, f.request, f.intent, true, phase => {
    if (phase === 'prepared') { const root = JSON.parse(f.original.toString()); root.principals.find((p: { id: string }) => p.id === 'source').source_epoch = 'epoch_2'; changed = Buffer.from(JSON.stringify(root)); writeFileSync(f.auth, changed); }
  }), 'HANDOVER_REGISTRY_CONFLICT');
  assert.deepEqual(readFileSync(f.auth), changed); assert.equal(f.store.device('phone')!.state, 'handover_pending');
  rejects(() => f.store.operatorRevoke('owner', 'phone', randomUUID()), 'HANDOVER_UNRESOLVED');
  rejects(() => f.authority.registry().authenticate(`Bearer ${f.user.token}`), 'UNAUTHENTICATED');
});

test('exact registry-parent sync EIO after rename preserves pending original handover; readable replacement is not activation', t => {
  const f = fixture(t); const parent = fs.statSync(f.registryDir); const original = fs.fsyncSync; let armed = false;
  fs.fsyncSync = fd => { const stat = fs.fstatSync(fd); if (armed && stat.isDirectory() && stat.ino === parent.ino && stat.dev === parent.dev) throw Object.assign(new Error('synthetic original registry parent EIO'), { code: 'EIO' }); original(fd); }; syncBuiltinESMExports();
  try { rejects(() => handoverStaticUser(f.store, f.request, f.intent, true, phase => { if (phase === 'file_replaced') armed = true; }), 'DEVICE_AUTHORITY_UNAVAILABLE'); }
  finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert.equal(f.store.device('phone')!.state, 'handover_pending'); assert.equal(f.store.handover(f.request.request_id)!.phase, 'prepared');
  rejects(() => fileRegistry(f.auth)().authenticate(`Bearer ${f.user.token}`), 'UNAUTHENTICATED'); rejects(() => f.store.authenticate(f.user.token), 'UNAUTHENTICATED');
  assert.equal(handoverStaticUser(f.store, f.request, f.intent, true).current_state, 'active'); untouched(f);
});

for (const phase of ['intent_saved','prepared','file_replaced','file_synced','activated'] as HandoverPhase[]) {
  test(`actual owned SIGKILL at handover ${phase} retains exact intent/actor/source and resumes without old-token static resurrection`, { timeout: 20000 }, async t => {
    const f = fixture(t); const signal = join(f.root, 'fault-boundary.signal');
    const child = fork(fileURLToPath(new URL('./fixtures/device-handover-process.ts', import.meta.url)), [], { execArgv: ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href], stdio: ['ignore','ignore','ignore','ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    assert.equal((await once(child, 'message'))[0].phase, 'ready');
    child.send({ path: f.store.path, store_id: f.store.storeId, request: f.request, intent: f.intent, fault: phase, signal });
    const deadline = Date.now() + 8000;
    while (!existsSync(signal)) { assert.ok(Date.now() < deadline && child.exitCode === null, 'Must observe the actual selected fault before killing'); await delay(10); }
    assert.equal(readFileSync(signal, 'utf8'), phase); const originalIntent = readFileSync(f.intent);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); assert.equal((await exit)[1], 'SIGKILL');
    const completed = handoverStaticUser(f.store, f.request, f.intent, true); assert.equal(completed.device_id, 'phone'); assert.equal(completed.current_state, 'active');
    assert.equal(f.store.list('owner').length, 1); assert.equal(f.store.authenticate(f.user.token).credential_version, 1); assert.deepEqual(readFileSync(f.intent), originalIntent); untouched(f);
    rejects(() => fileRegistry(f.auth)().authenticate(`Bearer ${f.user.token}`), 'UNAUTHENTICATED');
  });
}
