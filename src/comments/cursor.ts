import { type ZodType, z } from 'zod';
import { type AppError, appError } from '../core/errors.js';
import type { Platform } from '../core/platform.js';
import { err, ok, type Result } from '../core/result.js';

/**
 * Every platform paginates differently (Graph `after` cursors, YouTube
 * `pageToken`s, X `next_token`s, LinkedIn `start` offsets, TikTok integer
 * cursors). Clients see ONE opaque cursor. It wraps the provider's own
 * pagination state, tagged with the platform so a cursor can't be replayed
 * against a different platform.
 *
 * Not signed on purpose: cursors carry no authority (the post/account are
 * re-authorised on each request) and a tampered cursor just yields
 * VALIDATION_ERROR or an upstream 400.
 */
const Envelope = z.object({ v: z.literal(1), p: z.string(), s: z.unknown() });

export const encodeCursor = (platform: Platform, state: unknown): string =>
  Buffer.from(JSON.stringify({ v: 1, p: platform, s: state }), 'utf8').toString('base64url');

export const decodeCursor = (platform: Platform, cursor: string): Result<unknown, AppError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return err(appError('VALIDATION_ERROR', 'Cursor is malformed'));
  }
  const env = Envelope.safeParse(parsed);
  if (!env.success) return err(appError('VALIDATION_ERROR', 'Cursor is malformed'));
  if (env.data.p !== platform)
    return err(appError('VALIDATION_ERROR', 'Cursor was issued for a different platform'));
  return ok(env.data.s);
};

/** Adapters validate the wrapped state against their own schema. */
export const parseCursorState = <T>(schema: ZodType<T>, state: unknown): Result<T, AppError> => {
  const r = schema.safeParse(state);
  return r.success ? ok(r.data) : err(appError('VALIDATION_ERROR', 'Cursor is not valid for this platform'));
};
