import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentsCapability } from '../../src/comments/capability.js';
import { decodeCursor } from '../../src/comments/cursor.js';
import { InMemoryPostResolver, InMemoryReplyRepository } from '../../src/comments/repo/memory.js';
import { CommentService } from '../../src/comments/service.js';
import type { ExternalComment } from '../../src/comments/types.js';
import { appError } from '../../src/core/errors.js';
import { noopLogger } from '../../src/core/logger.js';
import { err, ok } from '../../src/core/result.js';
import { PlatformRegistry } from '../../src/platforms/adapter.js';
import { account, post } from '../helpers.js';

const external = (id: string, over: Partial<ExternalComment> = {}): ExternalComment => ({
  id,
  parentId: null,
  author: { id: 'u', username: 'someone', displayName: null, avatarUrl: null },
  isFromAccountOwner: false,
  text: `hi ${id}`,
  createdAt: '2026-08-02T10:00:00.000Z',
  likeCount: 1,
  replyCount: 0,
  permalink: null,
  ...over,
});

const makeCapability = (): CommentsCapability => ({
  limits: { maxPageSize: 50, maxReplyLength: 20, maxThreadDepth: 1 },
  listComments: vi.fn(async (_ctx, input) =>
    ok({
      items: [external('c1'), external('c2')],
      nextPage: input.cursorState === null ? { cursorState: { after: 'A' } } : null,
    }),
  ),
  reply: vi.fn(async (_ctx, input) =>
    ok(external('new-1', { parentId: input.commentId, text: input.text, isFromAccountOwner: true })),
  ),
});

const build = (capability: CommentsCapability, posts = [post()], now: () => Date = () => new Date()) => {
  const replies = new InMemoryReplyRepository(now);
  let n = 0;
  const service = new CommentService({
    platforms: new PlatformRegistry().register({ platform: 'instagram', comments: capability }),
    posts: new InMemoryPostResolver(posts, [account()], { 'acc-1': 'tok' }),
    replies,
    newId: () => `reply-${++n}`,
    now,
    pendingLeaseMs: 120_000,
  });
  return { service, replies };
};

describe('CommentService.listComments', () => {
  it('wraps platform pagination state into an opaque cursor and stamps platform/postId', async () => {
    const capability = makeCapability();
    const { service } = build(capability);
    const r = await service.listComments('user-1', 'post-1', { cursor: null, limit: 10 }, noopLogger);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items[0]).toMatchObject({ id: 'c1', platform: 'instagram', postId: 'post-1' });
    expect(decodeCursor('instagram', r.value.nextCursor ?? '')).toEqual({ ok: true, value: { after: 'A' } });

    const r2 = await service.listComments(
      'user-1',
      'post-1',
      { cursor: r.value.nextCursor, limit: 10 },
      noopLogger,
    );
    expect(r2.ok && r2.value.nextCursor).toBeNull();
    expect(capability.listComments).toHaveBeenLastCalledWith(expect.anything(), {
      cursorState: { after: 'A' },
      limit: 10,
    });
  });

  it("NOT_FOUND for another tenant's post; POST_NOT_PUBLISHED for drafts", async () => {
    const { service } = build(makeCapability(), [
      post(),
      post({ id: 'draft', status: 'draft', externalPostId: null }),
    ]);
    const other = await service.listComments('user-2', 'post-1', { cursor: null, limit: 10 }, noopLogger);
    expect(!other.ok && other.error.code).toBe('NOT_FOUND');
    const draft = await service.listComments('user-1', 'draft', { cursor: null, limit: 10 }, noopLogger);
    expect(!draft.ok && draft.error.code).toBe('POST_NOT_PUBLISHED');
  });

  it('PLATFORM_NOT_SUPPORTED when no adapter is registered, or the adapter lacks the comments capability', async () => {
    const { service } = build(makeCapability(), [post({ platform: 'pinterest' })]);
    const r = await service.listComments('user-1', 'post-1', { cursor: null, limit: 10 }, noopLogger);
    expect(!r.ok && r.error.code).toBe('PLATFORM_NOT_SUPPORTED');

    const publishingOnly = new CommentService({
      platforms: new PlatformRegistry().register({ platform: 'instagram' }),
      posts: new InMemoryPostResolver([post()], [account()], { 'acc-1': 'tok' }),
      replies: new InMemoryReplyRepository(),
    });
    const r2 = await publishingOnly.listComments('user-1', 'post-1', { cursor: null, limit: 10 }, noopLogger);
    expect(!r2.ok && r2.error.code).toBe('PLATFORM_NOT_SUPPORTED');
    expect(publishingOnly.support()).toEqual([]);
  });

  it('OPERATION_NOT_SUPPORTED when the capability has no listReplies', async () => {
    const { service } = build(makeCapability());
    const r = await service.listReplies('user-1', 'post-1', 'c1', { cursor: null, limit: 10 }, noopLogger);
    expect(!r.ok && r.error.code).toBe('OPERATION_NOT_SUPPORTED');
  });
});

describe('CommentService.reply — idempotency state machine', () => {
  let capability: CommentsCapability;
  let service: CommentService;
  let replies: InMemoryReplyRepository;
  beforeEach(() => {
    capability = makeCapability();
    ({ service, replies } = build(capability));
  });
  const send = (text = 'thanks!', key: string | null = 'k1') =>
    service.reply('user-1', 'post-1', 'c1', { text, idempotencyKey: key }, noopLogger);
  const row = () => [...replies.rows.values()][0];
  const mockReply = () => capability.reply as ReturnType<typeof vi.fn>;

  it('sends once, records the row as sent, replays on the same key without calling the platform again', async () => {
    const first = await send();
    expect(first.ok && first.value).toMatchObject({
      replayed: false,
      comment: { id: 'new-1', parentId: 'c1', postId: 'post-1' },
    });
    expect(row()).toMatchObject({
      status: 'sent',
      externalCommentId: 'new-1',
      attempts: 1,
      idempotencyKey: 'k1',
    });

    const again = await send();
    expect(again.ok && again.value).toMatchObject({
      replayed: true,
      comment: { id: 'new-1', text: 'thanks!' },
    });
    expect(capability.reply).toHaveBeenCalledTimes(1);
  });

  it('rejects the same key with a different payload', async () => {
    await send('thanks!');
    const r = await send('different text');
    expect(!r.ok && r.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { idempotencyKey: 'reused' },
    });
    expect(capability.reply).toHaveBeenCalledTimes(1);
  });

  it('retries a previously failed request with the same key, reusing the row', async () => {
    mockReply().mockResolvedValueOnce(err(appError('UPSTREAM_ERROR', 'boom')));
    expect((await send()).ok).toBe(false);
    expect(row()).toMatchObject({ status: 'failed', error: { code: 'UPSTREAM_ERROR' } });

    expect((await send()).ok).toBe(true);
    expect(replies.rows.size).toBe(1);
    expect(row()).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });

  it('marks a timed-out attempt as unknown and refuses to auto-retry it (never double-post)', async () => {
    mockReply().mockResolvedValueOnce(err(appError('UPSTREAM_TIMEOUT', 'slow')));
    const r1 = await send();
    expect(!r1.ok && r1.error.code).toBe('UPSTREAM_TIMEOUT');
    expect(row()?.status).toBe('unknown');

    const r2 = await send();
    expect(!r2.ok && r2.error).toMatchObject({ code: 'REPLY_CONFLICT', details: { status: 'unknown' } });
    expect(capability.reply).toHaveBeenCalledTimes(1);
  });

  it('reports REPLY_CONFLICT{pending} while a same-key request is in flight', async () => {
    let release!: () => void;
    mockReply().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok(external('new-1')));
        }),
    );
    const inflight = send();
    await new Promise((r) => setTimeout(r, 0));
    const second = await send();
    expect(!second.ok && second.error).toMatchObject({
      code: 'REPLY_CONFLICT',
      details: { status: 'pending' },
    });
    release();
    expect((await inflight).ok).toBe(true);
  });

  it('two concurrent retries of a failed row: exactly one reaches the platform', async () => {
    mockReply().mockResolvedValueOnce(err(appError('UPSTREAM_ERROR', 'boom')));
    await send();
    expect(row()?.status).toBe('failed');

    let release!: () => void;
    mockReply().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok(external('new-1')));
        }),
    );
    const transition = vi.spyOn(replies, 'transition');
    const [a, b] = [send(), send()]; // both read the row as `failed` before either claims it
    await new Promise((r) => setTimeout(r, 0));
    release();
    const results = await Promise.all([a, b]);
    expect(transition).toHaveBeenCalledTimes(2); // both got past the status check; the conditional update decided
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      error: { code: 'REPLY_CONFLICT', details: { status: 'pending' } },
    });
    expect(capability.reply).toHaveBeenCalledTimes(2);
    expect(row()).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('a pending row older than the lease becomes unknown on the next request — never re-sent', async () => {
    let t = Date.parse('2026-08-02T10:00:00Z');
    capability = makeCapability();
    ({ service, replies } = build(capability, [post()], () => new Date(t)));
    mockReply().mockImplementationOnce(() => new Promise(() => {})); // owner "dies" mid-call: never resolves
    void send();
    await new Promise((r) => setTimeout(r, 0));
    expect(row()?.status).toBe('pending');

    t += 119_000;
    const early = await send();
    expect(!early.ok && early.error.details).toEqual({ status: 'pending' });

    t += 2_000;
    const late = await send();
    expect(!late.ok && late.error.details).toMatchObject({ status: 'unknown' });
    expect(row()).toMatchObject({ status: 'unknown', error: { code: 'UPSTREAM_TIMEOUT' } });
    expect(capability.reply).toHaveBeenCalledTimes(1);
  });

  it('enforces the platform reply length limit before calling it', async () => {
    const r = await send('x'.repeat(21));
    expect(!r.ok && r.error.details).toEqual({ maxReplyLength: 20, length: 21 });
    expect(capability.reply).not.toHaveBeenCalled();
    expect(replies.rows.size).toBe(0);
  });
});
