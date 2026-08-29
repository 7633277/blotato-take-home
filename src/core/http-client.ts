import type { ZodType } from 'zod';
import { type AppError, appError } from './errors.js';
import type { Logger } from './logger.js';
import type { Platform } from './platform.js';
import { err, ok, type Result } from './result.js';

/**
 * ASSUMPTION (per brief): the platform already has a hardened HTTP client that
 * handles TLS, timeouts, retries with backoff+jitter on 429/5xx/network errors,
 * circuit breaking and per-account rate budgets. This file pins down the
 * contract the adapters depend on:
 *  - Non-2xx responses RESOLVE (not reject) so adapters can read the
 *    platform-specific error body and map it to an AppError.
 *  - Network failures / exhausted timeouts REJECT with HttpTransportError.
 * Tests use a scripted fake; production injects the real client.
 */
export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly url: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown; // JSON-encoded when present
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>; // lower-cased keys
  readonly body: unknown; // parsed JSON, or raw text if not JSON
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export class HttpTransportError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpTransportError';
  }
}

/* ---- Helpers shared by platform adapters --------------------------------- */

/** Perform a request; transport failures become UPSTREAM_TIMEOUT / UPSTREAM_ERROR. */
export const send = async (
  http: HttpClient,
  platform: Platform,
  req: HttpRequest,
): Promise<Result<HttpResponse, AppError>> => {
  try {
    return ok(await http.request(req));
  } catch (e) {
    if (!(e instanceof HttpTransportError)) throw e; // a bug, not an upstream condition
    return e.kind === 'timeout'
      ? err(appError('UPSTREAM_TIMEOUT', `${platform} did not respond in time`, { cause: e }))
      : err(appError('UPSTREAM_ERROR', `${platform} is unreachable`, { cause: e }));
  }
};

/** Validate a 2xx body against the schema we rely on; drift is loud, not silent. */
export const parseBody = <T>(
  platform: Platform,
  schema: ZodType<T>,
  body: unknown,
  log: Logger,
): Result<T, AppError> => {
  const r = schema.safeParse(body);
  if (r.success) return ok(r.data);
  log.error({ platform, issues: r.error.issues.slice(0, 5) }, 'upstream response failed schema validation');
  return err(
    appError('UPSTREAM_MALFORMED_RESPONSE', `${platform} returned an unexpected response shape`, {
      cause: r.error,
    }),
  );
};

/** Tokens go in headers, never in query strings (logs, proxies). */
export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** Fallback status → code mapping, used after the platform-specific error body has been inspected. */
export const errorFromStatus = (platform: Platform, status: number, retryAfterSeconds?: number): AppError => {
  if (status === 401)
    return appError(
      'ACCOUNT_AUTH_EXPIRED',
      `${platform} rejected the account's credentials; reconnect the account`,
    );
  if (status === 403) return appError('PERMISSION_DENIED', `${platform} denied access to this resource`);
  if (status === 404) return appError('NOT_FOUND', `Resource not found on ${platform}`);
  if (status === 429)
    return appError(
      'RATE_LIMITED',
      `${platform} rate limit reached`,
      retryAfterSeconds !== undefined ? { retryAfterSeconds } : {},
    );
  return appError('UPSTREAM_ERROR', `${platform} returned ${status}`, { retryable: status >= 500 });
};

export const retryAfterFrom = (
  headers: Readonly<Record<string, string>>,
  now: () => number = Date.now,
): number | undefined => {
  const ra = headers['retry-after'];
  if (ra && /^\d+$/.test(ra)) return Number(ra);
  const reset = headers['x-rate-limit-reset']; // X: unix epoch seconds
  if (reset && /^\d+$/.test(reset)) return Math.max(0, Number(reset) - Math.floor(now() / 1000));
  return undefined;
};

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
