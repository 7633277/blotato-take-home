import type { CommentsCapability } from '../../../comments/capability.js';
import type { HttpClient } from '../../../core/http-client.js';
import { limits } from './limits.js';
import { listComments, listReplies } from './list.js';
import { reply } from './reply.js';

/**
 * Instagram Graph API (professional accounts) — comments capability.
 * Threads are exactly one level deep: replying to a reply is rejected upstream.
 */
export const instagramComments = (http: HttpClient) =>
  ({
    limits,
    listComments: listComments(http),
    listReplies: listReplies(http),
    reply: reply(http),
  }) satisfies CommentsCapability;
