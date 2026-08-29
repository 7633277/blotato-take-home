import type { CommentsContext } from '../src/comments/capability.js';
import type { Post, SocialAccount } from '../src/core/entities.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/core/http-client.js';
import { HttpTransportError } from '../src/core/http-client.js';
import { noopLogger } from '../src/core/logger.js';

type Responder = (req: HttpRequest) => HttpResponse | Error;

/** Scripted HTTP client: records every request, answers from a queue. */
export class FakeHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private readonly queue: Responder[] = [];

  respond(res: Partial<HttpResponse> | Responder): this {
    this.queue.push(
      typeof res === 'function' ? res : () => ({ status: 200, headers: {}, body: null, ...res }),
    );
    return this;
  }

  timeout(): this {
    return this.respond(() => new HttpTransportError('timeout', 'timed out'));
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const next = this.queue.shift();
    if (!next) throw new Error(`FakeHttpClient: unexpected request ${req.method} ${req.url}`);
    const out = next(req);
    if (out instanceof Error) throw out;
    return out;
  }

  get last(): HttpRequest {
    const r = this.requests.at(-1);
    if (!r) throw new Error('no requests made');
    return r;
  }
}

export const account = (over: Partial<SocialAccount> = {}): SocialAccount => ({
  id: 'acc-1',
  userId: 'user-1',
  platform: 'instagram',
  externalAccountId: 'owner-123',
  displayName: 'Blotato',
  ...over,
});

export const post = (over: Partial<Post> = {}): Post => ({
  id: 'post-1',
  userId: 'user-1',
  accountId: 'acc-1',
  platform: 'instagram',
  status: 'published',
  externalPostId: 'media-999',
  publishedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

export const ctx = (over: Partial<CommentsContext> = {}): CommentsContext => ({
  account: account(),
  credentials: { accessToken: 'tok-secret' },
  externalPostId: 'media-999',
  log: noopLogger,
  ...over,
});
