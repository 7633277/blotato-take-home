import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { InMemoryPostResolver, InMemoryReplyRepository } from '../../../src/comments/repo/memory.js';
import { CommentService } from '../../../src/comments/service.js';
import { buildPlatformRegistry } from '../../../src/platforms/index.js';
import { account, FakeHttpClient, post } from '../../helpers.js';

const igPage = {
  status: 200,
  body: {
    data: [
      { id: '1', text: 'hey', timestamp: '2026-08-02T10:00:00+0000', from: { id: 'f', username: 'fan' } },
    ],
    paging: { cursors: { after: 'A' }, next: 'https://next' },
  },
};

describe('REST API', () => {
  let app: FastifyInstance;
  let http: FakeHttpClient;
  const h = { 'x-user-id': 'user-1' };

  beforeAll(async () => {
    http = new FakeHttpClient();
    const service = new CommentService({
      platforms: buildPlatformRegistry(http),
      posts: new InMemoryPostResolver(
        [post(), post({ id: 'draft', status: 'draft', externalPostId: null })],
        [account()],
        { 'acc-1': 'tok' },
      ),
      replies: new InMemoryReplyRepository(),
    });
    app = buildApp(service, { logger: false });
    await app.ready();
  });
  afterAll(() => app.close());

  it('401 without credentials', async () => {
    expect((await app.inject({ method: 'GET', url: '/v2/posts/post-1/comments' })).statusCode).toBe(401);
  });

  it('GET /v2/comments/capabilities lists per-platform support', async () => {
    const res = await app.inject({ method: 'GET', url: '/v2/comments/capabilities', headers: h });
    const caps = res.json().data as Array<{ platform: string; reply: boolean; listReplies: boolean }>;
    expect(caps.map((c) => c.platform).sort()).toEqual(['instagram', 'x']);
    expect(caps.find((c) => c.platform === 'x')).toMatchObject({ reply: true, listReplies: false });
  });

  it('GET /v2/posts/:postId/comments returns a page with an opaque cursor', async () => {
    http.respond(igPage);
    const res = await app.inject({ method: 'GET', url: '/v2/posts/post-1/comments?limit=5', headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0]).toMatchObject({
      id: '1',
      platform: 'instagram',
      postId: 'post-1',
      text: 'hey',
    });
    expect(typeof res.json().nextCursor).toBe('string');
  });

  it('400 on invalid query or cursor, 404 unknown post, 409 unpublished', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/v2/posts/post-1/comments?limit=0', headers: h })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v2/posts/post-1/comments?cursor=nope', headers: h }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v2/posts/nope/comments', headers: h })).statusCode).toBe(
      404,
    );
    const draft = await app.inject({ method: 'GET', url: '/v2/posts/draft/comments', headers: h });
    expect(draft.statusCode).toBe(409);
    expect(draft.json().error.code).toBe('POST_NOT_PUBLISHED');
  });

  it('429 with Retry-After when the platform rate limits; 504 on timeout', async () => {
    http.respond({ status: 400, body: { error: { code: 4 } } });
    const limited = await app.inject({ method: 'GET', url: '/v2/posts/post-1/comments', headers: h });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json().error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });

    http.timeout();
    const slow = await app.inject({ method: 'GET', url: '/v2/posts/post-1/comments', headers: h });
    expect(slow.statusCode).toBe(504);
    expect(slow.json().error.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('POST reply → 201, replay → 201 + Idempotent-Replayed, key reuse → 400', async () => {
    const url = '/v2/posts/post-1/comments/1/replies';
    http.respond({ status: 200, body: { id: 'new-1' } });
    const first = await app.inject({
      method: 'POST',
      url,
      headers: { ...h, 'idempotency-key': 'abc' },
      payload: { text: 'thanks!' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({ id: 'new-1', parentId: '1', isFromAccountOwner: true });

    const replay = await app.inject({
      method: 'POST',
      url,
      headers: { ...h, 'idempotency-key': 'abc' },
      payload: { text: 'thanks!' },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const reused = await app.inject({
      method: 'POST',
      url,
      headers: { ...h, 'idempotency-key': 'abc' },
      payload: { text: 'other' },
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error.details).toEqual({ idempotencyKey: 'reused' });
  });

  it('400 on over-long text (platform limit) without calling upstream', async () => {
    const before = http.requests.length;
    const res = await app.inject({
      method: 'POST',
      url: '/v2/posts/post-1/comments/1/replies',
      headers: h,
      payload: { text: 'x'.repeat(2201) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toMatchObject({ maxReplyLength: 2200 });
    expect(http.requests.length).toBe(before);
  });
});
