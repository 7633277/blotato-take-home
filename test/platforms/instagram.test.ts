import { describe, expect, it } from 'vitest';
import { instagramComments } from '../../src/platforms/instagram/comments/index.js';
import { ctx, FakeHttpClient } from '../helpers.js';
import { commentsContract } from './contract.js';

const page = {
  status: 200,
  body: {
    data: [
      {
        id: '1790001',
        text: 'love this',
        timestamp: '2026-08-02T10:00:00+0000',
        like_count: 3,
        from: { id: 'fan-1', username: 'fan' },
      },
      {
        id: '1790002',
        text: 'me!',
        timestamp: '2026-08-02T11:00:00+0000',
        from: { id: 'owner-123', username: 'blotato' },
      },
    ],
    paging: { cursors: { after: 'AFTER-1' }, next: 'https://graph.facebook.com/next' },
  },
};

commentsContract('instagram', instagramComments, {
  listPage: page,
  replyOk: { status: 200, body: { id: '1790099' } },
  authExpired: {
    status: 400,
    body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } },
  },
  rateLimited: {
    status: 400,
    body: { error: { message: '(#4) Application request limit reached', type: 'OAuthException', code: 4 } },
  },
});

describe('instagram specifics', () => {
  it('lists /{media}/comments, detects the owner, and only reports a next page when `paging.next` is present', async () => {
    const http = new FakeHttpClient()
      .respond(page)
      .respond({ status: 200, body: { data: [], paging: { cursors: { after: 'AFTER-1' } } } });
    const ig = instagramComments(http);
    const r1 = await ig.listComments(ctx(), { cursorState: null, limit: 10 });
    expect(http.last.url).toBe('https://graph.facebook.com/v21.0/media-999/comments');
    expect(r1.ok && r1.value.items[0]).toMatchObject({
      parentId: null,
      author: { username: 'fan' },
      likeCount: 3,
      isFromAccountOwner: false,
    });
    expect(r1.ok && r1.value.items[1]?.isFromAccountOwner).toBe(true);

    const r2 = await ig.listComments(ctx(), {
      cursorState: r1.ok && r1.value.nextPage ? r1.value.nextPage.cursorState : null,
      limit: 10,
    });
    expect(http.last.query).toMatchObject({ after: 'AFTER-1' });
    expect(r2.ok && r2.value.nextPage).toBeNull();
  });

  it('posts replies as {message} to /{comment}/replies', async () => {
    const http = new FakeHttpClient().respond({ status: 200, body: { id: 'new' } });
    await instagramComments(http).reply(ctx(), { commentId: '1790001', text: 'thanks' });
    expect(http.last).toMatchObject({
      method: 'POST',
      url: 'https://graph.facebook.com/v21.0/1790001/replies',
      body: { message: 'thanks' },
    });
  });

  it('maps Graph error codes', async () => {
    for (const [error, code] of [
      [{ code: 10 }, 'PERMISSION_DENIED'],
      [{ code: 100, error_subcode: 33 }, 'NOT_FOUND'],
      [{ code: 17 }, 'RATE_LIMITED'],
    ] as const) {
      const r = await instagramComments(
        new FakeHttpClient().respond({ status: 400, body: { error } }),
      ).listComments(ctx(), { cursorState: null, limit: 1 });
      expect(!r.ok && r.error.code, JSON.stringify(error)).toBe(code);
    }
  });
});
