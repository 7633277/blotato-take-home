import { z } from 'zod';
import { type AppError, appError } from '../../core/errors.js';
import { errorFromStatus, retryAfterFrom } from '../../core/http-client.js';

/** X API v2 error mapping — problem+json bodies, status-driven. */
const XError = z.object({
  title: z.string().optional(),
  detail: z.string().optional(),
  type: z.string().optional(),
});

export const mapXError = (
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>>,
): AppError => {
  const e = XError.safeParse(body);
  if (status === 401)
    return appError('ACCOUNT_AUTH_EXPIRED', 'X token is invalid or expired; reconnect the account');
  if (status === 403) {
    const detail = e.success ? (e.data.detail ?? '') : '';
    return /duplicate/i.test(detail)
      ? appError('VALIDATION_ERROR', 'X rejected the reply as a duplicate of a recent post')
      : appError('PERMISSION_DENIED', `X refused the request${detail ? `: ${detail}` : ''}`);
  }
  return errorFromStatus('x', status, retryAfterFrom(headers));
};
