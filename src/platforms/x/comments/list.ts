import type { CommentsCapability } from '../../../comments/capability.js';
import { parseCursorState } from '../../../comments/cursor.js';
import type { HttpClient } from '../../../core/http-client.js';
import { bearer, clamp, parseBody, send } from '../../../core/http-client.js';
import { andThenAsync, err, ok } from '../../../core/result.js';
import { mapXError } from '../errors.js';
import { limits } from './limits.js';
import { toExternal } from './normalize.js';
import { API, CursorState, SearchPage } from './schemas.js';

/**
 * GET /tweets/search/recent?query=conversation_id:{post} is:reply — the whole thread, any depth,
 * flattened; `parentId` is derived per tweet. `is:reply` excludes the root post itself (its own
 * conversation_id matches); the id filter below is belt-and-braces for the same case.
 * Basic tiers only see the last 7 days (full-archive needs pro).
 */
export const listComments =
  (http: HttpClient): CommentsCapability['listComments'] =>
  async (ctx, input) => {
    const cursor = input.cursorState === null ? ok(null) : parseCursorState(CursorState, input.cursorState);
    if (!cursor.ok) return cursor;
    const res = await send(http, 'x', {
      method: 'GET',
      url: `${API}/tweets/search/recent`,
      headers: bearer(ctx.credentials.accessToken),
      query: {
        query: `conversation_id:${ctx.externalPostId} is:reply`,
        max_results: clamp(input.limit, 10, limits.maxPageSize), // X's floor is 10
        next_token: cursor.value?.nextToken,
        'tweet.fields': 'author_id,created_at,public_metrics,referenced_tweets',
        expansions: 'author_id',
        'user.fields': 'username,name,profile_image_url',
      },
    });
    return andThenAsync(res, async (r) => {
      if (r.status >= 400) return err(mapXError(r.status, r.body, r.headers));
      const parsed = parseBody('x', SearchPage, r.body, ctx.log);
      if (!parsed.ok) return parsed;
      const users = new Map((parsed.value.includes?.users ?? []).map((u) => [u.id, u]));
      return ok({
        items: (parsed.value.data ?? [])
          .filter((t) => t.id !== ctx.externalPostId)
          .map((t) => toExternal(ctx, t, users)),
        nextPage: parsed.value.meta.next_token
          ? { cursorState: { nextToken: parsed.value.meta.next_token } }
          : null,
      });
    });
  };
