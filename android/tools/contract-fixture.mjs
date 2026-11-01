// Starts only a fresh loopback T001 server; random credentials stay in a private temp directory.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createApp } from '../../server/dist/app.js';
import { openDatabase } from '../../server/dist/database.js';
import { fileRegistry } from '../../server/dist/auth.js';
import { DeviceStore } from '../../server/dist/device-store.js';
import { DeviceAuthority } from '../../server/dist/device-authority.js';
const root = mkdtempSync(join(tmpdir(), 'notifier-android-contract-'));
const auth = join(root, 'auth.json');
const user = { id: 'phone', owner_id: 'fixture', kind: 'user', token: randomBytes(32).toString('hex') };
const source = { id: 'source_actor', owner_id: 'fixture', kind: 'source', source_id: 'assistant', source_epoch: 'epoch_1', capabilities: ['publish', 'reply', 'read_responses'], token: randomBytes(32).toString('hex') };
writeFileSync(auth, JSON.stringify({ principals: [user, source] }), { mode: 0o600 }); chmodSync(root, 0o700);
const authorityPath = join(root, 'device-authority.sqlite');
const storeId = DeviceStore.initialize(authorityPath).store_id;
const deviceStore = new DeviceStore(authorityPath, storeId);
const deviceAuthority = new DeviceAuthority(deviceStore, fileRegistry(auth));
// Synthetic observation contract only; actual Pi source-paused admission/lifecycle has separate host/platform evidence.
const observedAt = new Date().toISOString();
const sourceRuntime = { owner_id: source.owner_id, source_id: source.source_id, source_epoch: source.source_epoch,
  observe: () => ({ source_id: source.source_id, source_epoch: source.source_epoch, state: 'paused', model_permission_configured: false,
    reason_code: 'SOURCE_PAUSED_EXPLICIT', observed_at: observedAt }) };
const app = createApp(openDatabase(join(root, 'fixture.sqlite')), false, { deviceAuthority, sourceRuntime });
try {
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const pairing = join(root, 'pairing-private.json');
  const packages = Array.from({ length: 5 }, (_, index) => {
    const pkg = { notifier_pairing: 1, base: url, store_id: storeId, invitation_id: randomUUID(), secret: randomBytes(32).toString('hex'), expires_at: Date.now() + 15 * 60 * 1000, owner_id: 'fixture', label: `Socket device ${index + 1}`, manage_devices: index === 3 };
    deviceStore.createInvitation('operator', { request_id: pkg.invitation_id, invitation_id: pkg.invitation_id, secret: pkg.secret, expires_at: pkg.expires_at, owner_id: pkg.owner_id, label: pkg.label, manage_devices: pkg.manage_devices }); return pkg;
  });
  writeFileSync(pairing, JSON.stringify({ packages }), { mode: 0o600 });
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Supply the Gradle command and arguments');
  const child = spawn(command, args, { cwd: resolve('android'), stdio: 'inherit', env: { ...process.env, NOTIFIER_TEST_URL: url, NOTIFIER_TEST_AUTH: auth, NOTIFIER_TEST_PAIRING: pairing } });
  process.exitCode = await new Promise((done, reject) => { child.on('error', reject); child.on('exit', code => done(code ?? 1)); });
} finally { await app.close(); deviceStore.close(); }
// Preserve this run's evidence directory; no production resources are touched.
