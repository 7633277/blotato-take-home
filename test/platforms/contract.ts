import { describe, expect, it } from 'vitest';
import type { CommentsCapability } from '../../src/comments/capability.js';
import { ExternalCommentSchema } from '../../src/comments/types.js';
import type { HttpResponse } from '../../src/core/http-client.js';
import { ctx, FakeHttpClient } from '../helpers.js';

export interface ContractFixtures {
  /** A realistic first-page response with at least one item and a next page. */
  listPage: Partial<HttpResponse>;
  /** A response for a successful reply. */
  replyOk?: Partial<HttpResponse>;
  /** A response the platform gives for an expired/invalid token. */
  authExpired: Partial<HttpResponse>;
  /** A response the platform gives when rate-limited. */
  rateLimited: Partial<HttpResponse>;
}

/**
 * Every platform's comments capability must satisfy this. It's what makes
 * "add a platform without touching existing code" safe: the new
 * `platforms/<name>/comments/` folder either passes the contract or it doesn't ship.
 */
export const commentsContract = (
  name: string,
  make: (http: FakeHttpClient) => CommentsCapability,
  fx: ContractFixtures,
): void => {
  describe(`comments capability contract: ${name}`, () => {
    it('declares sane limits', () => {
      const p = make(new FakeHttpClient());
      expect(p.limits.maxPageSize).toBeGreaterThan(0);
      expect(p.limits.maxReplyLength).toBeGreaterThan(0);
      if (p.limits.maxThreadDepth !== null) expect(p.limits.maxThreadDepth).toBeGreaterThanOrEqual(1);
    });

    it('sends the token in a header, never in the URL/query', async () => {
      const http = new FakeHttpClient().respond(fx.listPage);
      await make(http).listComments(ctx(), { cursorState: null, limit: 10 });
      const req = http.last;
      expect(req.headers?.authorization).toBe('Bearer tok-secret');
      expect(req.url).not.toContain('tok-secret');
      expect(JSON.stringify(req.query ?? {})).not.toContain('tok-secret');
    });

    it('normalises the first page into valid ExternalComments with JSON-serialisable cursor state', async () => {
      const http = new FakeHttpClient().respond(fx.listPage);
      const r = await make(http).listComments(ctx(), { cursorState: null, limit: 10 });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.value.items.length).toBeGreaterThan(0);
      for (const c of r.value.items)
        expect(ExternalCommentSchema.safeParse(c).success, JSON.stringify(c)).toBe(true);
      expect(r.value.nextPage).not.toBeNull();
      expect(JSON.parse(JSON.stringify(r.value.nextPage?.cursorState))).toEqual(
        r.value.nextPage?.cursorState,
      );
    });

    it('rejects cursor state it did not issue', async () => {
      const r = await make(new FakeHttpClient()).listComments(ctx(), {
        cursorState: { bogus: 1 },
        limit: 10,
      });
      expect(!r.ok && r.error.code).toBe('VALIDATION_ERROR');
    });

    it('maps malformed upstream JSON to UPSTREAM_MALFORMED_RESPONSE', async () => {
      const http = new FakeHttpClient().respond({ status: 200, body: { totally: 'unexpected' } });
      const r = await make(http).listComments(ctx(), { cursorState: null, limit: 10 });
      expect(!r.ok && r.error.code).toBe('UPSTREAM_MALFORMED_RESPONSE');
    });

    it('maps expired credentials to ACCOUNT_AUTH_EXPIRED', async () => {
      const r = await make(new FakeHttpClient().respond(fx.authExpired)).listComments(ctx(), {
        cursorState: null,
        limit: 10,
      });
      expect(!r.ok && r.error.code).toBe('ACCOUNT_AUTH_EXPIRED');
    });

    it('maps rate limiting to RATE_LIMITED with a retry hint', async () => {
      const r = await make(new FakeHttpClient().respond(fx.rateLimited)).listComments(ctx(), {
        cursorState: null,
        limit: 10,
      });
      expect(!r.ok && r.error.code).toBe('RATE_LIMITED');
      if (!r.ok) {
        expect(r.error.retryable).toBe(true);
        expect(r.error.retryAfterSeconds).toBeGreaterThan(0);
      }
    });

    it('maps transport timeouts to UPSTREAM_TIMEOUT, and lets programmer errors propagate', async () => {
      const r = await make(new FakeHttpClient().timeout()).listComments(ctx(), {
        cursorState: null,
        limit: 10,
      });
      expect(!r.ok && r.error.code).toBe('UPSTREAM_TIMEOUT');
      const bug = new FakeHttpClient().respond(() => new TypeError('client bug'));
      await expect(make(bug).listComments(ctx(), { cursorState: null, limit: 10 })).rejects.toThrow(
        'client bug',
      );
    });

    if (fx.replyOk) {
      const replyOk = fx.replyOk;
      it('reply returns a valid ExternalComment authored by the account owner, parented to the target', async () => {
        const http = new FakeHttpClient().respond(replyOk);
        const p = make(http);
        if (!p.reply) throw new Error('replyOk fixture given but reply operation is absent');
        const r = await p.reply(ctx(), { commentId: 'parent-1', text: 'thank you' });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        if (!r.ok) return;
        expect(ExternalCommentSchema.safeParse(r.value).success).toBe(true);
        expect(r.value).toMatchObject({ parentId: 'parent-1', isFromAccountOwner: true });
        expect(http.last.method).toBe('POST');
      });
    }
  });
};
