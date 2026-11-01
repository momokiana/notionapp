import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal } from './auth.js';
import { pageOf } from './core.js';
import { schemas } from './contracts.js';
import { NotificationStore } from './notifications.js';

export function registerNotificationRoutes(app: FastifyInstance, store: NotificationStore, principal: (request: FastifyRequest) => Principal, write: <T>(request: FastifyRequest, action: (principal: Principal) => T) => T = (request, action) => action(principal(request))) {
  const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
  const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' };
  app.get('/device/push', async request => store.device(principal(request)));
  app.put('/device/push', { schema: { body: object({ registration_id: id, expected_generation: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }, endpoint: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 2048 }] } }) } }, async request => write(request, current => store.register(current, request.body as { registration_id: string; expected_generation: number; endpoint: string | null })));
  app.post('/notifications/:id/receipt', { schema: { params: schemas.idParams, body: object({ nonce: { type: 'string', pattern: '^[a-f0-9]{64}$' }, state: { enum: ['device_received', 'notification_posted'] } }) } }, async request => write(request, current => store.receipt(current, (request.params as { id: string }).id, request.body as { nonce: string; state: 'device_received' | 'notification_posted' })));
  app.get('/notifications', { schema: { querystring: schemas.page } }, async request => { const page = pageOf(request.query as { after?: string; limit?: string }); return store.list(principal(request), page.after, page.limit); });
}
