/**
 * One error taxonomy for the whole feature. Platform adapters translate
 * platform-specific failures (Graph API code 190, X 429 ...) into these codes;
 * the HTTP layer maps codes to statuses. Nothing in between needs to know
 * which platform produced the error. Codes are grouped by what the caller
 * should do next: fix the request, wait/change state, give up, or retry.
 */
export type ErrorCode =
  // fix the request
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  // wait, or change state first
  | 'POST_NOT_PUBLISHED'
  | 'REPLY_CONFLICT' // details.status: 'pending' (in flight) | 'unknown' (timed out; may have been delivered)
  | 'ACCOUNT_AUTH_EXPIRED' // the connected social account needs a reconnect — not the API caller
  // give up: the platform can't do this
  | 'PLATFORM_NOT_SUPPORTED'
  | 'OPERATION_NOT_SUPPORTED'
  | 'PERMISSION_DENIED'
  // retry later
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_MALFORMED_RESPONSE' // our zod schema for the platform is stale; loud on purpose
  | 'INTERNAL';

export interface AppError {
  readonly code: ErrorCode;
  readonly message: string;
  /** Safe for clients to retry the same request as-is (after `retryAfterSeconds` if present). */
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  /** Structured, client-safe details. Never raw upstream bodies. */
  readonly details?: Record<string, unknown>;
  /** Internal only, for logs. Never serialised to clients. */
  readonly cause?: unknown;
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['RATE_LIMITED', 'UPSTREAM_ERROR', 'UPSTREAM_TIMEOUT']);

export const appError = (
  code: ErrorCode,
  message: string,
  extra: Partial<Omit<AppError, 'code' | 'message'>> = {},
): AppError => ({
  code,
  message,
  retryable: RETRYABLE.has(code),
  ...extra,
});

export const httpStatusOf = (code: ErrorCode): number => {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'PERMISSION_DENIED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'POST_NOT_PUBLISHED':
    case 'REPLY_CONFLICT':
    case 'ACCOUNT_AUTH_EXPIRED':
      return 409;
    case 'PLATFORM_NOT_SUPPORTED':
    case 'OPERATION_NOT_SUPPORTED':
      return 422;
    case 'RATE_LIMITED':
      return 429;
    case 'UPSTREAM_ERROR':
    case 'UPSTREAM_MALFORMED_RESPONSE':
      return 502;
    case 'UPSTREAM_TIMEOUT':
      return 504;
    case 'INTERNAL':
      return 500;
  }
};
