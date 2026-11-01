import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { chmodSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { HTTPMethods } from 'fastify';
import { createApp } from '../src/app.js';
import { parseRegistry } from '../src/auth.js';
import { openDatabase } from '../src/database.js';
import { DeviceStore, credentialHash } from '../src/device-store.js';
import { DeviceAuthority } from '../src/device-authority.js';
import { credentials, NOW } from './helpers.js';

const token = () => randomBytes(32).toString('hex');
function fixture(t: TestContext) {
  const root = mkdtempSync('/tmp/notifier-device-api-'); chmodSync(root, 0o700);
  const path = join(root, 'authority.sqlite'); const id = DeviceStore.initialize(path).store_id; const store = new DeviceStore(path, id);
  const config = credentials(); const authority = new DeviceAuthority(store, () => parseRegistry(config));
  const app = createApp(openDatabase(join(root, 'ledger.sqlite')), false, { deviceAuthority: authority, now: () => NOW });
  t.after(async () => { await app.close(); store.close(); });
  const req = (method: HTTPMethods, url: string, credential?: string, payload?: object) => app.inject({ method, url, ...(credential === undefined ? {} : { headers: { authorization: `Bearer ${credential}` } }), ...(payload === undefined ? {} : { payload }) });
  const invite = (manager = false, owner = 'owner') => {
    const value = { request_id: randomUUID(), invitation_id: randomUUID(), secret: token(), owner_id: owner, label: 'API phone', manage_devices: manager, expires_at: Date.now() + 60000 };
    store.createInvitation('operator', value); return value;
  };
  const claim = async (manager = false, owner = 'owner') => {
    const invitation = invite(manager, owner); const proposed = token(); const body = { store_id: id, claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, proposed_token: proposed };
    const result = await req('POST', '/v1/pairing/claim', undefined, body); assert.equal(result.statusCode, 200, result.body);
    return { token: proposed, id: result.json().device_id as string, body, invitation };
  };
  return { store, app, config, req, invite, claim, id };
}

test('pair API binds the configured store and invitation, rejects invented roles, and persists one exact claim', async t => {
  const f = fixture(t); const invitation = f.invite(); const proposed = token(); const body = { store_id: f.id, claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, proposed_token: proposed };
  assert.equal((await f.req('POST', '/v1/pairing/claim', undefined, { ...body, owner_id: 'other', manage_devices: true })).statusCode, 422);
  assert.equal((await f.req('POST', '/v1/pairing/claim', undefined, { ...body, store_id: randomUUID() })).statusCode, 409);
  const first = await f.req('POST', '/v1/pairing/claim', undefined, body); assert.equal(first.statusCode, 200);
  assert.deepEqual((await f.req('POST', '/v1/pairing/claim', undefined, body)).json(), first.json());
  assert.equal((await f.req('POST', '/v1/pairing/claim', undefined, { ...body, claim_id: randomUUID() })).statusCode, 409);
  const self = await f.req('GET', '/v1/device/self', proposed); assert.equal(self.statusCode, 200); assert.equal(self.json().owner_id, 'owner'); assert.equal(self.json().manage_devices, false);
  assert.equal(self.body.includes(proposed), false); assert.equal(self.body.includes(invitation.secret), false);
  assert.equal((await f.req('GET', `/v1/device/claims/${body.claim_id}`, proposed)).json().device_id, first.json().device_id);
});

test('managed API authenticates before validation; source and ordinary device cannot manage other credentials', async t => {
  const f = fixture(t); const a = await f.claim(); const b = await f.claim(); const other = await f.claim(false, 'other'); const source = f.config.principals.find(p => p.kind === 'source')!;
  assert.equal((await f.req('POST', '/v1/device/rotate', undefined, { bad: true })).statusCode, 401);
  assert.equal((await f.req('POST', '/v1/device/rotate', source.token, { bad: true })).statusCode, 403);
  assert.equal((await f.req('POST', '/v1/device/revoke', a.token, { request_id: randomUUID(), device_id: b.id })).statusCode, 403);
  assert.equal((await f.req('POST', '/v1/device/revoke', a.token, { request_id: randomUUID(), device_id: other.id })).statusCode, 404);
  const visible = await f.req('GET', '/v1/devices', a.token); assert.equal(visible.statusCode, 200); assert.equal(visible.json().items.length, 2); assert.equal(visible.body.includes(other.id), false); assert.equal(visible.body.includes(b.token), false);
});

test('rotation API uses new authenticated token for exact transition, never reactivates an old credential', async t => {
  const f = fixture(t); const a = await f.claim(); const b = await f.claim(); const replacement = token(); const request = randomUUID();
  assert.equal((await f.req('POST', '/v1/device/rotate', a.token, { request_id: request, replacement_token: replacement })).statusCode, 200);
  assert.equal((await f.req('GET', '/v1/device/self', a.token)).statusCode, 401);
  const self = await f.req('GET', '/v1/device/self', replacement); assert.equal(self.json().device_id, a.id); assert.equal(self.json().credential_version, 2);
  const proof = await f.req('GET', `/v1/device/transitions/${request}`, replacement); assert.equal(proof.statusCode, 200); assert.equal(proof.json().previous_credential_hash, credentialHash(a.token)); assert.equal(proof.json().replacement_credential_hash, credentialHash(replacement));
  assert.equal((await f.req('GET', `/v1/device/transitions/${request}`, b.token)).statusCode, 404);
  const newest = token(); assert.equal((await f.req('POST', '/v1/device/rotate', replacement, { request_id: randomUUID(), replacement_token: newest })).statusCode, 200);
  assert.equal((await f.req('GET', `/v1/device/transitions/${request}`, newest)).statusCode, 404);
});

test('self-revocation exposes only one target-bound original fact and no route-prefix login bypass', async t => {
  const f = fixture(t); const a = await f.claim(); const b = await f.claim(); const request = randomUUID();
  assert.equal((await f.req('POST', '/v1/device/revoke', a.token, { request_id: request, device_id: a.id })).statusCode, 200);
  assert.equal((await f.req('GET', '/v1/devices', a.token)).statusCode, 401);
  const fact = await f.req('POST', '/v1/device/self-revocation-receipt', a.token, { request_id: request, device_id: a.id }); assert.equal(fact.statusCode, 200); assert.equal(fact.json().revoked, true);
  assert.equal((await f.req('POST', '/v1/device/self-revocation-receipt', a.token, { request_id: request, device_id: b.id })).statusCode, 404);
  assert.equal((await f.req('POST', '/v1/device/self-revocation-receipt', b.token, { request_id: request, device_id: a.id })).statusCode, 404);
  assert.equal((await f.req('POST', '/v1/device/self-revocation-receipt/events', a.token, {})).statusCode, 404);
  assert.equal((await f.req('GET', '/v1/device/self', a.token)).statusCode, 401);
});

test('explicit owner manager can invite/revoke invitations but cannot invent another owner or renew an old claim', async t => {
  const f = fixture(t); const manager = await f.claim(true); const ordinary = await f.claim();
  const invitation = { request_id: randomUUID(), invitation_id: randomUUID(), secret: token(), owner_id: 'owner', label: 'Second phone', manage_devices: false, expires_at: Date.now() + 60000 };
  assert.equal((await f.req('POST', '/v1/device/invitations', ordinary.token, invitation)).statusCode, 403);
  assert.equal((await f.req('POST', '/v1/device/invitations', manager.token, { ...invitation, owner_id: 'other' })).statusCode, 403);
  assert.equal((await f.req('POST', '/v1/device/invitations', manager.token, invitation)).statusCode, 200);
  assert.equal((await f.req('POST', `/v1/device/invitations/${invitation.invitation_id}/revoke`, manager.token, { request_id: randomUUID() })).statusCode, 200);
  const failed = await f.req('POST', '/v1/pairing/claim', undefined, { store_id: f.id, claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, proposed_token: token() }); assert.equal(failed.statusCode, 410); assert.equal(failed.json().error.code, 'PAIRING_REVOKED');
  assert.equal((await f.req('GET', '/v1/device/self', ordinary.token)).statusCode, 200);
});

test('current issuer may query only its original other-device revocation, not another issuer or a revoked general login', async t => {
  const f = fixture(t); const manager = await f.claim(true); const a = await f.claim(); const outsider = await f.claim(); const request = randomUUID();
  assert.equal((await f.req('POST', '/v1/device/revoke', manager.token, { request_id: request, device_id: a.id })).statusCode, 200);
  const fact = await f.req('GET', `/v1/device/revocations/${request}`, manager.token); assert.equal(fact.statusCode, 200); assert.equal(fact.json().device_id, a.id); assert.equal(fact.json().revoked, true);
  assert.equal((await f.req('GET', `/v1/device/revocations/${request}`, outsider.token)).statusCode, 404);
  assert.equal((await f.req('GET', `/v1/device/revocations/${request}`, a.token)).statusCode, 401);
});
