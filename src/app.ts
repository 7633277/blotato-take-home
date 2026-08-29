import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerAuthStub } from './comments/http/auth.js';
import { registerCommentRoutes } from './comments/http/routes.js';
import type { CommentService } from './comments/service.js';

export const buildApp = (service: CommentService, opts: FastifyServerOptions = {}): FastifyInstance => {
  const app = Fastify({ logger: true, ...opts });
  registerAuthStub(app);
  registerCommentRoutes(app, service);
  app.setErrorHandler((error: unknown, request, reply) => {
    // Anything reaching here is a bug or a framework-level rejection (bad JSON, payload too large).
    const e = error as { statusCode?: unknown; message?: unknown };
    const status =
      typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500;
    if (status === 500) request.log.error({ err: error }, 'unhandled error');
    return reply.code(status).send({
      error: {
        code: status === 500 ? 'INTERNAL' : 'VALIDATION_ERROR',
        message: status === 500 ? 'Internal error' : String(e.message ?? 'Bad request'),
        retryable: status === 500,
      },
    });
  });
  return app;
};
