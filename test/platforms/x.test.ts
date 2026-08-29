import { describe, expect, it } from 'vitest';
import { xComments } from '../../src/platforms/x/comments/index.js';
import { ctx, FakeHttpClient } from '../helpers.js';
import { commentsContract } from './contract.js';

const search = {
  status: 200,
  body: {
    data: [
      {
        id: 'media-999',
        text: 'the post itself',
        author_id: 'owner-123',
        created_at: '2026-08-02T09:00:00.000Z',
      },
      {
        id: '9002',
        text: 'nested reply',
        author_id: 'u2',
        created_at: '2026-08-02T10:05:00.000Z',
        referenced_tweets: [{ type: 'replied_to', id: '9001' }],
      },
      {
        id: '9001',
        text: 'top-level reply',
        author_id: 'owner-123',
        created_at: '2026-08-02T10:00:00.000Z',
        public_metrics: { like_count: 5, reply_count: 1 },
        referenced_tweets: [{ type: 'replied_to', id: 'media-999' }],
      },
    ],
    includes: {
      users: [
        { id: 'u2', username: 'fan', name: 'Fan' },
        { id: 'owner-123', username: 'blotato' },
      ],
    },
    meta: { next_token: 'NEXT', result_count: 3 },
  },
};

commentsContract('x', xComments, {
  listPage: search,
  replyOk: { status: 201, body: { data: { id: '9100', text: 'thank you' } } },
  authExpired: { status: 401, body: { title: 'Unauthorized' } },
  rateLimited: {
    status: 429,
    headers: { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 120) },
    body: { title: 'Too Many Requests' },
  },
});

describe('x specifics', () => {
  it('searches replies in the conversation, drops the root post, derives parentId from referenced_tweets', async () => {
    const http = new FakeHttpClient().respond(search);
    const r = await xComments(http).listComments(ctx(), { cursorState: null, limit: 5 });
    expect(http.last.query).toMatchObject({
      query: 'conversation_id:media-999 is:reply',
      max_results: 10,
      expansions: 'author_id',
    });
    expect(r.ok && r.value.items.map((c) => c.id)).toEqual(['9002', '9001']);
    expect(r.ok && r.value.items[0]).toMatchObject({
      id: '9002',
      parentId: '9001',
      author: { username: 'fan' },
      permalink: 'https://x.com/fan/status/9002',
    });
    expect(r.ok && r.value.items[1]).toMatchObject({
      id: '9001',
      parentId: null,
      isFromAccountOwner: true,
      likeCount: 5,
    });
    expect(r.ok && r.value.nextPage).toEqual({ cursorState: { nextToken: 'NEXT' } });
  });

  it('has no listReplies operation (no such query on X)', () => {
    expect('listReplies' in xComments(new FakeHttpClient())).toBe(false);
  });

  it('posts replies with reply.in_reply_to_tweet_id and maps duplicates to VALIDATION_ERROR', async () => {
    const http = new FakeHttpClient()
      .respond({ status: 201, body: { data: { id: '1', text: 'ty' } } })
      .respond({
        status: 403,
        body: { detail: 'You are not allowed to create a Tweet with duplicate content.' },
      });
    const cap = xComments(http);
    await cap.reply(ctx(), { commentId: '9001', text: 'ty' });
    expect(http.last).toMatchObject({
      method: 'POST',
      url: 'https://api.x.com/2/tweets',
      body: { text: 'ty', reply: { in_reply_to_tweet_id: '9001' } },
    });
    const dup = await cap.reply(ctx(), { commentId: '9001', text: 'ty' });
    expect(!dup.ok && dup.error.code).toBe('VALIDATION_ERROR');
  });
});
