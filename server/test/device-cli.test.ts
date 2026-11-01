import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { DeviceStore } from '../src/device-store.js';
import { parsePairingPackage } from '../src/pairing-package.js';

const cli = fileURLToPath(new URL('../src/device-cli.ts', import.meta.url));
const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
function run(...args: string[]) { return spawnSync(process.execPath, ['--import', loader, cli, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 }); }
function setup(t: TestContext) {
  const root = mkdtempSync('/tmp/notifier-device-cli-'); chmodSync(root, 0o700); const path = join(root, 'authority.sqlite');
  const initialized = run('init','--path',path); assert.equal(initialized.status, 0, initialized.stderr); const id = JSON.parse(initialized.stdout).store_id as string;
  const store = new DeviceStore(path, id); t.after(() => store.close());
  const out = join(root, 'pairing.json'); const args = ['invite','--path',path,'--store-id',id,'--owner','owner','--base','https://app.example.test','--label','Phone','--out',out];
  return { root, path, id, store, out, args };
}

test('CLI private invitation persists exact original package before grant and normal output never prints secret', { timeout: 30000 }, t => {
  const f = setup(t); const first = run(...f.args); assert.equal(first.status, 0, first.stderr);
  const bytes = readFileSync(f.out); const pkg = parsePairingPackage(bytes.toString()); assert.equal(statSync(f.out).mode & 0o777, 0o600);
  assert.equal(first.stdout.includes(pkg.secret), false); assert.equal(first.stderr.includes(pkg.secret), false);
  const again = run(...f.args); assert.equal(again.status, 0, again.stderr); assert.deepEqual(JSON.parse(again.stdout), JSON.parse(first.stdout)); assert.deepEqual(readFileSync(f.out), bytes);
  const changed = run(...f.args.slice(0,-2),'--out',f.out,'--manager'); assert.equal(changed.status, 1); assert.equal(JSON.parse(changed.stderr).error, 'ORIGINAL_INVITATION_DIFFERS'); assert.deepEqual(readFileSync(f.out), bytes);
  const proposed = randomBytes(32).toString('hex'); f.store.claim({ claim_id: randomUUID(), invitation_id: pkg.invitation_id, secret: pkg.secret, token: proposed }, () => {}); assert.equal(f.store.authenticate(proposed).manage_devices, false);
});

test('CLI explicit show is the only secret display; unsafe package permissions are not fixed or overwritten', { timeout: 30000 }, t => {
  const f = setup(t); assert.equal(run(...f.args).status, 0); const bytes = readFileSync(f.out); const pkg = parsePairingPackage(bytes.toString());
  const show = run('show','--out',f.out); assert.equal(show.status, 0); assert.equal(JSON.parse(show.stdout).secret, pkg.secret); assert.match(show.stderr, /PAIRING_SECRET_DISPLAY/);
  chmodSync(f.out, 0o644); const refused = run(...f.args); assert.equal(refused.status, 1); assert.deepEqual(readFileSync(f.out), bytes); assert.equal(statSync(f.out).mode & 0o777, 0o644);
});

test('CLI operator revocation keeps stable original request/target and exact receipt, never prints credentials', { timeout: 30000 }, t => {
  const f = setup(t); assert.equal(run(...f.args).status, 0); const pkg = parsePairingPackage(readFileSync(f.out, 'utf8')); const proposed = randomBytes(32).toString('hex');
  const claim = f.store.claim({ claim_id: randomUUID(), invitation_id: pkg.invitation_id, secret: pkg.secret, token: proposed }, () => {}); const request = randomUUID();
  const args = ['revoke','--path',f.path,'--store-id',f.id,'--owner','owner','--device',claim.device_id,'--request',request];
  const first = run(...args); assert.equal(first.status, 0, first.stderr); assert.equal(first.stdout.includes(proposed), false);
  assert.deepEqual(JSON.parse(run(...args).stdout), JSON.parse(first.stdout));
  assert.deepEqual(JSON.parse(run('receipt','--path',f.path,'--store-id',f.id,'--request',request).stdout), JSON.parse(first.stdout));
  assert.equal(run(...args.slice(0,-4),'--device','different_device','--request',request).status, 1);
  assert.throws(() => f.store.authenticate(proposed));
});

test('pairing package is bounded, versioned and canonical, never accepts arbitrary public HTTP or invented fields', () => {
  const pkg = { notifier_pairing: 1, base: 'https://app.example.test', store_id: randomUUID(), invitation_id: randomUUID(), secret: randomBytes(32).toString('hex'), expires_at: 0, owner_id: 'owner', label: 'Phone', manage_devices: false };
  assert.deepEqual(parsePairingPackage(JSON.stringify(pkg)), pkg);
  for (const change of [{ base: 'http://example.test' }, { base: 'https://APP.example.test:443' }, { base: 'https://app.example.test/path' }, { base: 'https://user:pass@app.example.test' }, { notifier_pairing: 2 }, { manage_devices: ['true'] }, { code: 'run' }]) assert.throws(() => parsePairingPackage(JSON.stringify({ ...pkg, ...change })));
  assert.throws(() => parsePairingPackage(' '.repeat(8193))); assert.throws(() => parsePairingPackage(JSON.stringify({ ...pkg, base: 'http://127.0.0.1:3000' })));
  assert.equal(parsePairingPackage(JSON.stringify({ ...pkg, base: 'http://127.0.0.1:3000' }), true).base, 'http://127.0.0.1:3000');
});

test('CLI exact static handover requires explicit writer-control acknowledgement, removes old static token, and prints no secret', { timeout: 30000 }, t => {
  const f = setup(t); const auth = join(f.root, 'static.json'); const raw = randomBytes(32).toString('hex');
  writeFileSync(auth, JSON.stringify({ principals: [{ id: 'original_phone', owner_id: 'owner', kind: 'user', token: raw }] }), { mode: 0o600 });
  const inspected = run('inspect-static','--auth-file',auth); assert.equal(inspected.status, 0); assert.equal(inspected.stdout.includes(raw), false); const meta = JSON.parse(inspected.stdout);
  const args = ['handover','--path',f.path,'--store-id',f.id,'--owner','owner','--device','original_phone','--request',randomUUID(),'--auth-file',auth,'--expected-token-hash',meta.identities[0].credential_fingerprint,'--expected-file-hash',meta.registry_digest,'--label','Original phone','--intent',join(f.root,'handover.json')];
  assert.equal(run(...args).status, 1);
  const completed = run(...args,'--exclusive-registry-control'); assert.equal(completed.status, 0, completed.stderr); assert.equal(completed.stdout.includes(raw), false); assert.equal(JSON.parse(completed.stdout).current_state, 'active');
  assert.deepEqual(JSON.parse(readFileSync(auth, 'utf8')), { principals: [] }); assert.equal(f.store.authenticate(raw).id, 'original_phone');
  assert.equal(JSON.parse(run(...args,'--exclusive-registry-control').stdout).historical_completion, true);
});
