import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal, Registry } from './auth.js';
import { schemas, type UpdateEvent } from './contracts.js';
import { DeliveryStore, type NativeReceipt } from './delivery.js';

export function registerDeliveryRoutes(app: FastifyInstance, store: DeliveryStore, context: (request: FastifyRequest) => { principal: Principal; registry: Registry }) {
  const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' };
  const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
  const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
  const idOf = (r: FastifyRequest) => (r.params as { id: string }).id;
  app.post('/source/commands/claim', { schema: { body: object({ claim_id: id }) } }, async request => {
    const { principal, registry } = context(request); return store.claim(principal, (request.body as { claim_id: string }).claim_id, registry);
  });
  app.get('/source/commands/:id', { schema: { params: schemas.idParams } }, async request => ({ command: store.get(context(request).principal, idOf(request)) }));
  app.post('/source/commands/:id/validate', { schema: { params: schemas.idParams, body: object({}) } }, async request => {
    const { principal, registry } = context(request); return store.validate(principal, idOf(request), registry);
  });
  app.post('/source/commands/:id/receipt', { schema: { params: schemas.idParams, body: object({ receipt_id: id, command_id: id, session_ref: text(512), state_revision: text(200), message_id: text(512) }) } }, async request => {
    const { receipt_id, ...receipt } = request.body as NativeReceipt & { receipt_id: string };
    return store.receipt(context(request).principal, idOf(request), receipt_id, receipt);
  });
  app.post('/source/commands/:id/updates', { schema: { params: schemas.idParams, body: schemas.update } }, async request => store.update(context(request).principal, idOf(request), request.body as UpdateEvent));
  // No HTTP input/execute endpoint. Only the explicitly enabled synchronous native host may submitAtGate.
}
