import { z } from 'zod';

export const API = 'https://api.x.com/2';

export const CursorState = z.object({ nextToken: z.string().min(1) });

export const Tweet = z.object({
  id: z.string(),
  text: z.string(),
  author_id: z.string().optional(),
  created_at: z.string(), // always requested via tweet.fields; absence is schema drift, not a null
  public_metrics: z
    .object({ like_count: z.number().int().optional(), reply_count: z.number().int().optional() })
    .optional(),
  referenced_tweets: z.array(z.object({ type: z.string(), id: z.string() })).optional(),
});
export type Tweet = z.infer<typeof Tweet>;

export const User = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string().optional(),
  profile_image_url: z.string().url().optional(),
});
export type User = z.infer<typeof User>;

export const SearchPage = z.object({
  data: z.array(Tweet).optional(),
  includes: z.object({ users: z.array(User).optional() }).optional(),
  meta: z.object({ next_token: z.string().optional(), result_count: z.number().int().optional() }),
});

export const CreatedTweet = z.object({ data: z.object({ id: z.string(), text: z.string() }) });
