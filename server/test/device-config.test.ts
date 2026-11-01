import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DeviceStore } from '../src/device-store.js';
import { openDeviceRegistry } from '../src/device-config.js';
import { fileRegistry } from '../src/auth.js';

test('selected original managed store is never created or replaced and does not escape through a valid static token', () => {
  const root = mkdtempSync('/tmp/notifier-device-config-'); chmodSync(root, 0o700);
  const path = join(root, 'authority.sqlite'); const auth = join(root, 'static.json'); const token = randomBytes(32).toString('hex');
  writeFileSync(auth, JSON.stringify({ principals: [{ id: 'legacy', kind: 'user', owner_id: 'owner', token }] }), { mode: 0o600 });
  assert.equal(openDeviceRegistry(auth).registry().authenticate(`Bearer ${token}`).id, 'legacy');
  assert.throws(() => openDeviceRegistry(auth, { path, store_id: randomUUID() }));
  const id = DeviceStore.initialize(path).store_id; const original = readFileSync(path);
  assert.throws(() => openDeviceRegistry(auth, { path, store_id: randomUUID() })); assert.deepEqual(readFileSync(path), original);
  const selected = openDeviceRegistry(auth, { path, store_id: id });
  try { assert.equal(selected.registry().authenticate(`Bearer ${token}`).id, 'legacy'); chmodSync(path, 0o644); assert.throws(() => selected.registry().authenticate(`Bearer ${token}`)); }
  finally { selected.close(); }
});

test('empty static registry is accepted only for an explicitly valid managed store; omitting provider cannot authorize a removed token', () => {
  const root = mkdtempSync('/tmp/notifier-device-empty-static-'); chmodSync(root, 0o700);
  const path = join(root, 'authority.sqlite'); const id = DeviceStore.initialize(path).store_id; const auth = join(root, 'static.json');
  writeFileSync(auth, JSON.stringify({ principals: [] }), { mode: 0o600 });
  assert.throws(() => fileRegistry(auth)());
  const selected = openDeviceRegistry(auth, { path, store_id: id });
  try { assert.throws(() => selected.registry().authenticate(`Bearer ${randomBytes(32).toString('hex')}`)); }
  finally { selected.close(); }
});
