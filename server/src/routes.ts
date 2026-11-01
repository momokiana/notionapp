import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { ApiError, type Principal, type Registry, type RegistryProvider } from './auth.js';
import { CoreStore, pageOf } from './core.js';
import { DeliveryStore } from './delivery.js';
import { registerDeliveryRoutes } from './delivery-routes.js';
import { NotificationStore, type PushConfig } from './notifications.js';
import { registerNotificationRoutes } from './notification-routes.js';
import { installApiErrors } from './api-errors.js';
import { observeSourceRuntime, type SourceRuntimeProvider } from './source-runtime.js';
import { schemas, type CreateEvent, type UpdateEvent, type SubmitResponse, type Disposition } from './contracts.js';

export function registerCore(app: FastifyInstance, db: Database.Database, provider: RegistryProvider, now: () => number = Date.now, push?: PushConfig, runtime?: SourceRuntimeProvider): NotificationStore {
  const store = new CoreStore(db, now);
  const delivery = new DeliveryStore(db, now);
  const notifications = new NotificationStore(db, provider, push, now);
  void app.register(async scoped => {
    const contexts = new WeakMap<FastifyRequest, { principal: Principal; registry: Registry }>();
    scoped.addHook('onRequest', async request => {
      const registry = provider();
      contexts.set(request, { principal: registry.authenticate(request.headers.authorization), registry });
    });
    installApiErrors(scoped);
    const ctx = (request: FastifyRequest) => {
      const value = contexts.get(request);
      if (!value) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication is required');
      return value;
    };
    const write = <T>(request: FastifyRequest, action: (principal: Principal, registry: Registry) => T): T => {
      const { principal, registry } = ctx(request);
      if (principal.kind === 'user' && provider.userWrite) return provider.userWrite(request.headers.authorization, principal, action);
      return action(principal, registry);
    };
    registerDeliveryRoutes(scoped, delivery, ctx);
    registerNotificationRoutes(scoped, notifications, request => ctx(request).principal, (request, action) => write(request, principal => action(principal)));
    scoped.get('/source-runtime/:source_id', { schema: {
      params: { type: 'object', additionalProperties: false, required: ['source_id'], properties: { source_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' } } },
      querystring: { type: 'object', additionalProperties: false, required: ['event_id', 'event_version'], properties: {
        event_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' }, event_version: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
      } },
    } }, async request => {
      const { principal, registry } = ctx(request); const query = request.query as { event_id: string; event_version: string };
      return observeSourceRuntime(runtime, store, principal, registry, (request.params as { source_id: string }).source_id, query.event_id, Number(query.event_version));
    });
    const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
    const page = (request: FastifyRequest) => pageOf(request.query as { after?: string; limit?: string });
    scoped.post('/events', { schema: { body: schemas.create } }, async request => store.create(ctx(request).principal, request.body as CreateEvent));
    scoped.get('/events', { schema: { querystring: schemas.page } }, async request => { const { principal, registry } = ctx(request); return store.listEvents(principal, page(request), registry); });
    scoped.get('/events/:id', { schema: { params: schemas.idParams } }, async request => { const { principal, registry } = ctx(request); return store.getEvent(principal, idOf(request), registry); });
    scoped.post('/events/:id/updates', { schema: { params: schemas.idParams, body: schemas.update } }, async request => store.update(ctx(request).principal, idOf(request), request.body as UpdateEvent));
    scoped.post('/events/:id/responses', { schema: { params: schemas.idParams, body: schemas.response } }, async request => write(request, (principal, registry) => store.respond(principal, idOf(request), request.body as SubmitResponse, registry)));
    scoped.get('/responses/:id', { schema: { params: schemas.idParams } }, async request => { const { principal, registry } = ctx(request); return store.getResponse(principal, idOf(request), registry); });
    scoped.get('/source/responses', { schema: { querystring: schemas.page } }, async request => { const { principal, registry } = ctx(request); return store.listResponses(principal, page(request), registry); });
    scoped.put('/events/:id/read-state', { schema: { params: schemas.idParams, body: schemas.read } }, async request => write(request, principal => store.read(principal, idOf(request), (request.body as { event_version: number }).event_version)));
    scoped.post('/events/:id/disposition', { schema: { params: schemas.idParams, body: schemas.disposition } }, async request => write(request, principal => store.disposition(principal, idOf(request), request.body as { request_id: string; expected_event_version: number; disposition: Disposition })));
    scoped.get('/events/:id/history', { schema: { params: schemas.idParams, querystring: schemas.page } }, async request => store.listHistory(ctx(request).principal, idOf(request), page(request)));
  }, { prefix: '/v1' });
  return notifications;
}
