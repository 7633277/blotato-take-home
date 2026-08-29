import type { FastifyReply } from 'fastify';
import { type AppError, httpStatusOf } from '../../core/errors.js';

export interface ErrorBody {
  error: {
    code: AppError['code'];
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    details?: Record<string, unknown>;
  };
}

/** Serialise an AppError. `cause` never leaves the process. */
export const sendError = (reply: FastifyReply, e: AppError): FastifyReply => {
  const status = httpStatusOf(e.code);
  if (e.retryAfterSeconds !== undefined) reply.header('retry-after', String(e.retryAfterSeconds));
  if (status >= 500 || e.code === 'INTERNAL') reply.log.error({ code: e.code, cause: e.cause }, e.message);
  const body: ErrorBody = {
    error: {
      code: e.code,
      message: e.message,
      retryable: e.retryable,
      ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
      ...(e.details ? { details: e.details } : {}),
    },
  };
  return reply.code(status).send(body);
};
