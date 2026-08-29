import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

/**
 * ASSUMPTION: the real service already authenticates API keys and attaches
 * the principal. This stub reads `x-user-id` so the endpoints are exercisable
 * locally and in tests. It must be replaced by the platform's auth plugin;
 * everything downstream only depends on `request.userId`.
 */
export const registerAuthStub = (app: FastifyInstance): void => {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    const userId = request.headers['x-user-id'];
    if (typeof userId !== 'string' || userId.length === 0) {
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: 'Missing credentials', retryable: false } });
    }
    request.userId = userId;
  });
};
