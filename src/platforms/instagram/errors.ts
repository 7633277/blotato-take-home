import { z } from 'zod';
import { type AppError, appError } from '../../core/errors.js';
import { errorFromStatus, retryAfterFrom } from '../../core/http-client.js';

/** Instagram Graph API error mapping — shared by every Instagram feature. */
const IgError = z.object({
  error: z.object({
    message: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
  }),
});

export const mapInstagramError = (
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>>,
): AppError => {
  const e = IgError.safeParse(body);
  const code = e.success ? e.data.error.code : undefined;
  const subcode = e.success ? e.data.error.error_subcode : undefined;
  switch (code) {
    case 190: // invalid/expired token
      return appError('ACCOUNT_AUTH_EXPIRED', 'Instagram token is invalid or expired; reconnect the account');
    case 4: // app rate limit
    case 17: // user rate limit
    case 32: // page rate limit
    case 613: // custom rate limit
      return appError('RATE_LIMITED', 'Instagram rate limit reached', {
        retryAfterSeconds: retryAfterFrom(headers) ?? 3600,
      });
    case 10:
    case 200:
    case 210:
    case 230:
    case 294:
      return appError(
        'PERMISSION_DENIED',
        'Instagram denied the request (missing permission or comments disabled)',
      );
    case 100:
      return subcode === 33
        ? appError('NOT_FOUND', 'Instagram object not found or not accessible')
        : appError(
            'VALIDATION_ERROR',
            (e.success && e.data.error.message) || 'Instagram rejected the request',
          );
    default:
      return errorFromStatus('instagram', status, retryAfterFrom(headers));
  }
};
