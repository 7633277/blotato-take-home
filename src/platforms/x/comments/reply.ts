import type { CommentsCapability } from '../../../comments/capability.js';
import type { ExternalComment } from '../../../comments/types.js';
import type { HttpClient } from '../../../core/http-client.js';
import { bearer, parseBody, send } from '../../../core/http-client.js';
import { andThenAsync, err, ok } from '../../../core/result.js';
import { mapXError } from '../errors.js';
import { API, CreatedTweet } from './schemas.js';

/** POST /tweets {text, reply:{in_reply_to_tweet_id}} — any depth. Needs tweet.write scope. */
export const reply =
  (http: HttpClient): NonNullable<CommentsCapability['reply']> =>
  async (ctx, input) => {
    const res = await send(http, 'x', {
      method: 'POST',
      url: `${API}/tweets`,
      headers: bearer(ctx.credentials.accessToken),
      body: { text: input.text, reply: { in_reply_to_tweet_id: input.commentId } },
    });
    return andThenAsync(res, async (r) => {
      if (r.status >= 400) return err(mapXError(r.status, r.body, r.headers));
      const parsed = parseBody('x', CreatedTweet, r.body, ctx.log);
      if (!parsed.ok) return parsed;
      return ok<ExternalComment>({
        id: parsed.value.data.id,
        parentId: input.commentId,
        author: {
          id: ctx.account.externalAccountId,
          username: null,
          displayName: ctx.account.displayName,
          avatarUrl: null,
        },
        isFromAccountOwner: true,
        text: parsed.value.data.text,
        createdAt: new Date().toISOString(),
        likeCount: 0,
        replyCount: 0,
        permalink: null,
      });
    });
  };
