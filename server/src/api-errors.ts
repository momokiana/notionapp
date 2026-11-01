import type { FastifyInstance } from 'fastify';
import { ApiError } from './auth.js';

/** Shared bounded errors: no raw body, token, endpoint or storage path is serialized/logged. */
export function installApiErrors(app: FastifyInstance) {
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ApiError) {
      request.log.warn({ code: err.code, request_id: request.id }, 'Core request rejected');
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const detail = err !== null && typeof err === 'object' ? err as { validation?: unknown; statusCode?: number; code?: string } : {};
    if (detail.validation || detail.statusCode === 400 || detail.statusCode === 415) return reply.code(detail.statusCode === 415 ? 415 : 422).send({ error: { code: 'INVALID_INPUT', message: 'Input does not match the API contract' } });
    if (detail.statusCode === 413) return reply.code(413).send({ error: { code: 'INPUT_TOO_LARGE', message: 'Request body exceeds the size limit' } });
    request.log.error({ code: detail.code ?? 'STORAGE_FAILURE', request_id: request.id }, 'Core storage operation failed');
    return reply.code(503).send({ error: { code: 'STORAGE_FAILURE', message: 'The operation could not be durably saved; query the original request ID before retrying' } });
  });
}
