import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodType } from 'zod';
import { type AppError, appError } from '../../core/errors.js';
import { err, ok, type Result } from '../../core/result.js';
import type { CommentService } from '../service.js';
import type { Comment, Page } from '../types.js';
import { sendError } from './errors.js';
import { CommentParams, IdempotencyKeyHeader, PageQuery, PostParams, ReplyBody } from './schemas.js';

const parse = <T>(schema: ZodType<T>, input: unknown, what: string): Result<T, AppError> => {
  const r = schema.safeParse(input);
  return r.success
    ? ok(r.data)
    : err(
        appError('VALIDATION_ERROR', `Invalid ${what}`, {
          details: { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        }),
      );
};

const sendPage = (reply: FastifyReply, page: Page<Comment>): FastifyReply =>
  reply.code(200).send({ data: page.items, nextCursor: page.nextCursor });

/**
 * REST surface. Resource hierarchy mirrors the domain: a post has comments,
 * a comment has replies. Comment ids are the platform's own ids (URL-encode
 * them; LinkedIn URNs contain ':' and parentheses).
 */
export const registerCommentRoutes = (app: FastifyInstance, service: CommentService): void => {
  // Discoverability: which platforms support which comment operations, and their limits.
  app.get('/v2/comments/capabilities', async (_req, reply) => reply.send({ data: service.support() }));

  app.get('/v2/posts/:postId/comments', async (request, reply) => {
    const params = parse(PostParams, request.params, 'path parameters');
    if (!params.ok) return sendError(reply, params.error);
    const query = parse(PageQuery, request.query, 'query');
    if (!query.ok) return sendError(reply, query.error);

    const page = await service.listComments(
      request.userId,
      params.value.postId,
      { cursor: query.value.cursor ?? null, limit: query.value.limit ?? 0 },
      request.log,
    );
    return page.ok ? sendPage(reply, page.value) : sendError(reply, page.error);
  });

  app.get('/v2/posts/:postId/comments/:commentId/replies', async (request, reply) => {
    const params = parse(CommentParams, request.params, 'path parameters');
    if (!params.ok) return sendError(reply, params.error);
    const query = parse(PageQuery, request.query, 'query');
    if (!query.ok) return sendError(reply, query.error);

    const page = await service.listReplies(
      request.userId,
      params.value.postId,
      params.value.commentId,
      { cursor: query.value.cursor ?? null, limit: query.value.limit ?? 0 },
      request.log,
    );
    return page.ok ? sendPage(reply, page.value) : sendError(reply, page.error);
  });

  app.post('/v2/posts/:postId/comments/:commentId/replies', async (request, reply) => {
    const params = parse(CommentParams, request.params, 'path parameters');
    if (!params.ok) return sendError(reply, params.error);
    const body = parse(ReplyBody, request.body, 'body');
    if (!body.ok) return sendError(reply, body.error);
    const rawKey = request.headers['idempotency-key'];
    const key =
      rawKey === undefined ? ok(null) : parse(IdempotencyKeyHeader, rawKey, 'Idempotency-Key header');
    if (!key.ok) return sendError(reply, key.error);

    const result = await service.reply(
      request.userId,
      params.value.postId,
      params.value.commentId,
      { text: body.value.text, idempotencyKey: key.value },
      request.log,
    );
    if (!result.ok) return sendError(reply, result.error);
    if (result.value.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(201).send({ data: result.value.comment });
  });
};
