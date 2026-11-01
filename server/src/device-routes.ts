import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, type Principal } from './auth.js';
import { installApiErrors } from './api-errors.js';
import { DeviceAuthority } from './device-authority.js';
import type { InviteInput } from './device-store.js';

const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' };
const secret = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const idParams = object({ id });
function token(request: FastifyRequest) {
  const found = /^Bearer ([a-f0-9]{64})$/i.exec(request.headers.authorization ?? '')?.[1];
  if (!found) throw new ApiError(401, 'UNAUTHENTICATED', 'A valid Bearer token is required');
  return found;
}

export function registerDeviceRoutes(app: FastifyInstance, authority: DeviceAuthority) {
  void app.register(async scoped => {
    installApiErrors(scoped);
    // Exactly these two routes have their own narrow authentication. No prefix-wide auth exemption.
    scoped.post('/pairing/claim', { schema: { body: object({ store_id: { type: 'string', minLength: 36, maxLength: 36 }, claim_id: id, invitation_id: id, secret, proposed_token: secret }) } }, async request => {
      const body = request.body as { store_id: string; claim_id: string; invitation_id: string; secret: string; proposed_token: string };
      if (body.store_id !== authority.store.storeId) throw new ApiError(409, 'DEVICE_STORE_MISMATCH', 'Pairing package targets a different original device authority');
      return authority.store.claim({ claim_id: body.claim_id, invitation_id: body.invitation_id, secret: body.secret, token: body.proposed_token }, authority.assertTokenAvailable);
    });
    scoped.post('/device/self-revocation-receipt', { schema: { body: object({ request_id: id, device_id: id }) } }, async request => {
      const body = request.body as { request_id: string; device_id: string };
      const result = authority.store.selfRevocationReceipt(token(request), body.request_id);
      if (result.device_id !== body.device_id) throw new ApiError(404, 'NOT_FOUND', 'Original self-revocation target does not match');
      return result;
    });
    void scoped.register(async protectedScope => {
      const contexts = new WeakMap<FastifyRequest, Principal>();
      protectedScope.addHook('onRequest', async request => {
        const principal = authority.registry().authenticate(request.headers.authorization);
        if (principal.kind !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Current managed user permission is required');
        authority.store.authenticate(token(request));
        contexts.set(request, principal);
      });
      const current = (request: FastifyRequest) => authority.store.authenticate(token(request));
      const write = <T>(request: FastifyRequest, action: () => T) => {
        const expected = contexts.get(request);
        if (!expected) throw new ApiError(401, 'UNAUTHENTICATED', 'Current user authentication is required');
        return authority.userWrite(request.headers.authorization, expected, action);
      };
      protectedScope.get('/device/self', async request => {
        const identity = current(request);
        return { store_id: identity.store_id, device_id: identity.id, owner_id: identity.owner_id, label: identity.label, manage_devices: identity.manage_devices, credential_version: identity.credential_version };
      });
      protectedScope.get('/device/claims/:id', { schema: { params: idParams } }, async request => authority.store.claimFact(token(request), (request.params as { id: string }).id));
      protectedScope.get('/device/transitions/:id', { schema: { params: idParams } }, async request => {
        const fact = authority.store.transition(token(request), (request.params as { id: string }).id);
        return { store_id: authority.store.storeId, request_id: fact.request_id, device_id: fact.device, owner_id: fact.owner, previous_credential_hash: fact.from_hash, replacement_credential_hash: fact.to_hash, previous_credential_version: fact.from_version, credential_version: fact.to_version };
      });
      protectedScope.get('/device/revocations/:id', { schema: { params: idParams } }, async request => authority.store.revocationFact(token(request), (request.params as { id: string }).id));
      protectedScope.get('/devices', async request => ({ items: authority.store.list(current(request).owner_id).map(d => ({ device_id: d.id, owner_id: d.owner, label: d.label, manage_devices: d.manager === 1, state: d.state, credential_version: d.credential_version, created_at: d.created_at })) }));
      protectedScope.post('/device/rotate', { schema: { body: object({ request_id: id, replacement_token: secret }) } }, async request => write(request, () => {
        const body = request.body as { request_id: string; replacement_token: string };
        const fact = authority.store.rotate(token(request), body.request_id, body.replacement_token, authority.assertTokenAvailable);
        return { request_id: fact.request_id, device_id: fact.device, credential_version: fact.to_version };
      }));
      protectedScope.post('/device/revoke', { schema: { body: object({ request_id: id, device_id: id }) } }, async request => write(request, () => {
        const body = request.body as { request_id: string; device_id: string };
        const result = authority.store.revoke(token(request), body.request_id, body.device_id);
        return { request_id: result.request_id, device_id: result.device_id, owner_id: result.owner_id, revoked: result.revoked };
      }));
      protectedScope.post('/device/invitations', { schema: { body: object({ request_id: id, invitation_id: id, secret, owner_id: id, label: { type: 'string', minLength: 1, maxLength: 80 }, manage_devices: { type: 'boolean' }, expires_at: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }) } }, async request => write(request, () => authority.invite(request.headers.authorization, request.body as InviteInput)));
      protectedScope.post('/device/invitations/:id/revoke', { schema: { params: idParams, body: object({ request_id: id }) } }, async request => write(request, () => {
        const identity = current(request);
        if (!identity.manage_devices) throw new ApiError(403, 'FORBIDDEN', 'Explicit current device management permission is required');
        return authority.store.revokeInvitation(identity.id, identity.owner_id, (request.params as { id: string }).id, (request.body as { request_id: string }).request_id);
      }));
    });
  }, { prefix: '/v1' });
}
