import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { DeviceStore, credentialHash } from '../src/device-store.js';

const token = () => randomBytes(32).toString('hex');
async function setup(t: TestContext) {
  const root = mkdtempSync('/tmp/notifier-device-ack-'); chmodSync(root, 0o700);
  const path = join(root, 'authority.sqlite'); const id = DeviceStore.initialize(path).store_id;
  const store = new DeviceStore(path, id); t.after(() => store.close());
  const authFile = join(root, 'static.json'); writeFileSync(authFile, JSON.stringify({ principals: [{ id: 'legacy', owner_id: 'owner', kind: 'user', token: token() }] }), { mode: 0o600 });
  const invitation = { request_id: randomUUID(), invitation_id: randomUUID(), secret: token(), owner_id: 'owner', label: 'ACK fixture', manage_devices: false, expires_at: Date.now() + 600000 }; store.createInvitation('operator', invitation);
  const body = { store_id: id, claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, proposed_token: token() };
  const start = async (port: number, drop?: { path: string; request_id: string }) => {
    const child = fork(fileURLToPath(new URL('./fixtures/device-api-process.ts', import.meta.url)), [], { execArgv: ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href], stdio: ['ignore','ignore','ignore','ipc'] });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } });
    assert.equal((await once(child, 'message'))[0].phase, 'waiting'); const ready = once(child, 'message');
    child.send({ authority_path: path, store_id: id, auth_file: authFile, ledger_path: join(root, 'ledger.sqlite'), port, ...(drop ? { drop } : {}) });
    const message = (await ready)[0]; assert.equal(message.phase, 'ready'); const url = message.url as string;
    const req = async (method: string, path: string, credential?: string, value?: object) => {
      const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', connection: 'close', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) });
      return { status: response.status, data: await response.json() as any };
    };
    const kill = async () => { const done = once(child, 'exit'); child.kill('SIGKILL'); const [, signal] = await done; assert.equal(signal, 'SIGKILL'); };
    return { child, url, req, kill };
  };
  const count = (table: 'devices' | 'transitions') => {
    const read = new Database(path, { readonly: true, fileMustExist: true }); read.pragma('query_only=ON'); read.exec('BEGIN');
    try { return (read.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n; } finally { read.exec('ROLLBACK'); read.close(); }
  };
  return { root, body, start, store, count };
}

test('real HTTP claim loses ACK, actual SIGKILL, same-root reopen reconciles original proposal and never creates another actor', { timeout: 30000 }, async t => {
  const f = await setup(t); const first = await f.start(0, { path: '/v1/pairing/claim', request_id: f.body.claim_id });
  // A private synthetic client journal, NOT Android/Keystore evidence. Persist whole exact intent before network.
  const intent = join(f.root, 'original-client-intent.json'); writeFileSync(intent, JSON.stringify({ root: first.url, body: f.body }), { mode: 0o600 }); const bytes = readFileSync(intent);
  const lost = once(first.child, 'message'); const request = first.req('POST', '/v1/pairing/claim', undefined, f.body);
  const rejection = assert.rejects(request); assert.equal((await lost)[0].phase, 'committed_ack_lost'); await rejection; await first.kill();
  assert.equal(f.count('devices'), 1);
  const resumed = await f.start(Number(new URL(first.url).port)); assert.equal(resumed.url, first.url);
  const self = await resumed.req('GET', '/v1/device/self', f.body.proposed_token); assert.equal(self.status, 200);
  const fact = await resumed.req('GET', `/v1/device/claims/${f.body.claim_id}`, f.body.proposed_token); assert.equal(fact.status, 200); assert.equal(fact.data.device_id, self.data.device_id);
  const replay = await resumed.req('POST', '/v1/pairing/claim', undefined, JSON.parse(readFileSync(intent, 'utf8')).body); assert.equal(replay.status, 200); assert.equal(replay.data.device_id, self.data.device_id);
  assert.equal(f.count('devices'), 1); assert.deepEqual(readFileSync(intent), bytes);
});

test('real HTTP rotation loses ACK/SIGKILL; old 401 does not erase intent and original new token proves exact transition', { timeout: 30000 }, async t => {
  const f = await setup(t); const requestId = randomUUID(); const first = await f.start(0, { path: '/v1/device/rotate', request_id: requestId });
  const paired = await first.req('POST', '/v1/pairing/claim', undefined, f.body); assert.equal(paired.status, 200);
  const replacement = token(); const original = { root: first.url, previous_hash: credentialHash(f.body.proposed_token), device_id: paired.data.device_id, body: { request_id: requestId, replacement_token: replacement } };
  const intent = join(f.root, 'original-rotation-intent.json'); writeFileSync(intent, JSON.stringify(original), { mode: 0o600 }); const bytes = readFileSync(intent);
  const lost = once(first.child, 'message'); const request = first.req('POST', '/v1/device/rotate', f.body.proposed_token, original.body);
  const rejection = assert.rejects(request); assert.equal((await lost)[0].phase, 'committed_ack_lost'); await rejection; await first.kill();
  const resumed = await f.start(Number(new URL(first.url).port)); assert.equal(resumed.url, first.url);
  assert.equal((await resumed.req('GET', '/v1/device/self', f.body.proposed_token)).status, 401); assert.deepEqual(readFileSync(intent), bytes);
  const self = await resumed.req('GET', '/v1/device/self', replacement); assert.equal(self.status, 200); assert.equal(self.data.device_id, original.device_id); assert.equal(self.data.credential_version, 2);
  const proof = await resumed.req('GET', `/v1/device/transitions/${requestId}`, replacement); assert.equal(proof.status, 200); assert.equal(proof.data.previous_credential_hash, original.previous_hash); assert.equal(proof.data.replacement_credential_hash, credentialHash(replacement));
  assert.equal(f.count('devices'), 1); assert.equal(f.count('transitions'), 1); assert.deepEqual(readFileSync(intent), bytes);
});
