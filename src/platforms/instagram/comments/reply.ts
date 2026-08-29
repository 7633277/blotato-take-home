import type { CommentsCapability } from '../../../comments/capability.js';
import type { ExternalComment } from '../../../comments/types.js';
import type { HttpClient } from '../../../core/http-client.js';
import { bearer, parseBody, send } from '../../../core/http-client.js';
import { andThenAsync, err, ok } from '../../../core/result.js';
import { mapInstagramError } from '../errors.js';
import { GRAPH, IgCreated } from './schemas.js';

/** POST /{ig-comment-id}/replies {message}. Graph returns only `{ id }`; we synthesise the rest. */
export const reply =
  (http: HttpClient): NonNullable<CommentsCapability['reply']> =>
  async (ctx, input) => {
    const res = await send(http, 'instagram', {
      method: 'POST',
      url: `${GRAPH}/${encodeURIComponent(input.commentId)}/replies`,
      headers: bearer(ctx.credentials.accessToken),
      body: { message: input.text },
    });
    return andThenAsync(res, async (r) => {
      if (r.status >= 400) return err(mapInstagramError(r.status, r.body, r.headers));
      const parsed = parseBody('instagram', IgCreated, r.body, ctx.log);
      if (!parsed.ok) return parsed;
      return ok<ExternalComment>({
        id: parsed.value.id,
        parentId: input.commentId,
        author: {
          id: ctx.account.externalAccountId,
          username: null,
          displayName: ctx.account.displayName,
          avatarUrl: null,
        },
        isFromAccountOwner: true,
        text: input.text,
        createdAt: new Date().toISOString(),
        likeCount: 0,
        replyCount: 0,
        permalink: null,
      });
    });
  };
