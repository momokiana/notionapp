import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeviceStore } from 'notification-server/device-store';
import { AppRuntime } from '../src/runtime.js';
import { NativeSession, PiNativeHost } from '../src/native.js';
import { fixture, fakeModels } from './helpers.js';

test('optional managed provider opens original v3 ledger/native/manifest unchanged and closes after runtime without requesting any model', async t => {
  const f = fixture(false); f.init(); const original = f.config;
  const manifestPath = join(original.data_dir, 'manifest.json'); const manifest = readFileSync(manifestPath); const nativePath = JSON.parse(manifest.toString()).session_file as string; const native = readFileSync(nativePath);
  const path = join(f.root, 'device-authority.sqlite'); const id = DeviceStore.initialize(path).store_id;
  writeFileSync(f.configFile, JSON.stringify({ ...f.value, device_auth: { path, store_id: id } }), { mode: 0o600 }); const config = f.config;
  assert.equal(config.bindingHash, original.bindingHash); assert.deepEqual(config.model_budget, original.model_budget); assert.deepEqual(config.source, original.source);
  const models = await fakeModels(f.root); const runtime = await AppRuntime.open(config, { modelRuntime: models.runtime }); t.after(() => runtime.close());
  assert.equal(runtime.native.database.pragma('user_version', { simple: true }), 3); assert.equal(runtime.native.manifest.binding_hash, original.bindingHash);
  assert.equal(runtime.registry().authenticate(`Bearer ${f.sourceToken}`).kind, 'source'); assert.ok(runtime.deviceAuthority);
  await runtime.runOnce(); assert.equal(models.calls.length, 0); assert.deepEqual(readFileSync(nativePath), native); assert.deepEqual(readFileSync(manifestPath), manifest);
  await runtime.close(); assert.throws(() => runtime.deviceAuthority!.store.assertReady()); assert.equal(existsSync(path), true); assert.deepEqual(readFileSync(nativePath), native); assert.deepEqual(readFileSync(manifestPath), manifest);
});

test('configured missing/wrong device authority refuses without original-native repair, static fallback, injected override or model request', async () => {
  const f = fixture(false); f.init(); const manifestPath = join(f.config.data_dir, 'manifest.json'); const manifest = readFileSync(manifestPath); const nativePath = JSON.parse(manifest.toString()).session_file as string; const native = readFileSync(nativePath);
  const path = join(f.root, 'missing-device-authority.sqlite'); writeFileSync(f.configFile, JSON.stringify({ ...f.value, device_auth: { path, store_id: randomUUID() } }), { mode: 0o600 });
  const models = await fakeModels(f.root);
  await assert.rejects(AppRuntime.open(f.config, { modelRuntime: models.runtime }));
  await assert.rejects(AppRuntime.open(f.config, { modelRuntime: models.runtime, registry: () => f.registry() }), /DEVICE_AUTHORITY_OVERRIDE_FORBIDDEN/);
  assert.equal(existsSync(path), false); assert.equal(models.calls.length, 0); assert.deepEqual(readFileSync(nativePath), native); assert.deepEqual(readFileSync(manifestPath), manifest);
});

async function failedStartup(phase: 'profile' | 'model' | 'native_close' | 'session_dispose') {
  const f = fixture(false); f.init();
  const path = join(f.root, 'failed-open-authority.sqlite'); const id = DeviceStore.initialize(path).store_id;
  writeFileSync(f.configFile, JSON.stringify({ ...f.value, device_auth: { path, store_id: id } }), { mode: 0o600 });
  const config = f.config; const manifestPath = join(config.data_dir, 'manifest.json'); const manifest = readFileSync(manifestPath);
  const nativePath = JSON.parse(manifest.toString()).session_file as string; const native = readFileSync(nativePath);
  const stores = new Set<DeviceStore>(); const ready = DeviceStore.prototype.assertReady;
  const closeNative = NativeSession.prototype.close; const target = PiNativeHost.prototype.target;
  const fetch = globalThis.fetch; let network = 0; let opened: AppRuntime | undefined; let partialNative: NativeSession | undefined;
  const descriptors = () => readdirSync('/proc/self/fd').filter(fd => {
    try { const value = readlinkSync(`/proc/self/fd/${fd}`); return value === path || value.startsWith(path + '-'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  });
  const models = await fakeModels(f.root);
  try {
    globalThis.fetch = async () => { network++; throw new Error('Synthetic startup probe forbids all network'); };
    DeviceStore.prototype.assertReady = function () { if (this.path === path) stores.add(this); return ready.call(this); };
    if (phase === 'profile') writeFileSync(join(config.data_dir, 'agent/models.json'), JSON.stringify({ synthetic: '$NOT_A_CREDENTIAL' }), { mode: 0o600 });
    else if (phase !== 'session_dispose') models.runtime.getError = () => 'synthetic model admission refusal';
    if (phase === 'native_close') NativeSession.prototype.close = function () { closeNative.call(this); throw new Error('synthetic native cleanup error'); };
    if (phase === 'session_dispose') PiNativeHost.prototype.target = function () {
      partialNative = this.native;
      const dispose = this.session.dispose.bind(this.session);
      this.session.dispose = () => { dispose(); throw new Error('synthetic session cleanup error'); };
      throw new Error('synthetic post-session startup refusal');
    };
    await assert.rejects(async () => { opened = await AppRuntime.open(config, { modelRuntime: models.runtime }); },
      phase === 'profile' ? /EXECUTABLE_OR_AMBIENT_PROFILE_FORBIDDEN/ : phase === 'model' ? /INVALID_MODEL_PROFILE/ : /synthetic .* cleanup error/);
    assert.equal(stores.size, 1, 'Observe the actually owned managed provider, not a separate test connection');
    for (const store of stores) assert.throws(() => store.assertReady(), 'Rejected startup must close its managed provider');
    if (process.platform === 'linux') assert.deepEqual(descriptors(), [], 'No managed main/WAL/SHM descriptor may survive a rejected open');
    assert.equal(network, 0); assert.equal(models.calls.length, 0);
    assert.deepEqual(readFileSync(manifestPath), manifest); assert.deepEqual(readFileSync(nativePath), native);
  } finally {
    globalThis.fetch = fetch; DeviceStore.prototype.assertReady = ready;
    NativeSession.prototype.close = closeNative; PiNativeHost.prototype.target = target;
    await opened?.close(); partialNative?.close(); for (const store of stores) store.close();
  }
  // The original Native owner lock is also released; no replacement manifest/session is created.
  const again = new NativeSession(config); again.close();
  assert.deepEqual(readFileSync(manifestPath), manifest); assert.deepEqual(readFileSync(nativePath), native);
}

test('post-Native profile and model admission refusals release the exact managed provider without network or native changes', async () => {
  await failedStartup('profile'); await failedStartup('model');
});
test('post-Native rejected startup releases managed provider even if native cleanup throws', async () => {
  await failedStartup('native_close');
});
test('post-session rejected startup releases native and managed provider even if session dispose throws', async () => {
  await failedStartup('session_dispose');
});
