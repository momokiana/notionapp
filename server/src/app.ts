import Fastify, { type FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { ApiError, type RegistryProvider } from './auth.js';
import { registerCore } from './routes.js';
import { notificationConsumer, type PushConfig } from './notifications.js';
import type { DeviceAuthority } from './device-authority.js';
import { registerDeviceRoutes } from './device-routes.js';
import type { SourceRuntimeProvider } from './source-runtime.js';

const healthResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'storage'],
  properties: {
    status: { type: 'string', enum: ['ok', 'unavailable'] },
    storage: { type: 'string', enum: ['ready', 'unavailable'] },
  },
} as const;

// The application takes ownership of the connection and closes it on shutdown.
export function createApp(database: Database.Database, logger = false, options: { registry?: RegistryProvider; now?: () => number; push?: PushConfig; deviceAuthority?: DeviceAuthority; sourceRuntime?: SourceRuntimeProvider } = {}) {
  if (options.deviceAuthority && options.registry && options.registry !== options.deviceAuthority.registry) throw new Error('DEVICE_PROVIDER_MISMATCH');
  const provider = options.deviceAuthority?.registry ?? options.registry;
  const app = Fastify({
    logger: logger ? {
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      // Do not log raw URLs, headers or bodies, including credentials misplaced in a query.
      serializers: { req: (request: FastifyRequest) => ({ id: request.id, method: request.method, route: request.routeOptions?.url }) },
    } : false,
    bodyLimit: 65536,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  });

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route is not available' } }));

  let stopNotifications: (() => Promise<void>) | undefined;
  app.addHook('onClose', async () => {
    await stopNotifications?.();
    if (database.open) {
      database.close();
    }
  });

  app.get('/health', {
    schema: {
      response: { 200: healthResponseSchema, 503: healthResponseSchema },
    },
  }, async (request, reply) => {
    try {
      database.prepare('SELECT 1').get();
      return { status: 'ok', storage: 'ready' };
    } catch {
      request.log.error({ code: 'STORAGE_UNAVAILABLE', request_id: request.id }, 'SQLite health check failed');
      return reply.code(503).send({ status: 'unavailable', storage: 'unavailable' });
    }
  });

  const notifications = registerCore(app, database, provider ?? (() => { throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Authentication configuration is unavailable'); }), options.now, options.push, options.sourceRuntime);
  if (options.deviceAuthority) registerDeviceRoutes(app, options.deviceAuthority);
  app.addHook('onReady', async () => { if (options.push) stopNotifications = notificationConsumer(notifications, options.push); });
  return app;
}
