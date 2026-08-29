/**
 * Minimal Result type. Errors that are part of the domain (rate limits, expired
 * tokens, unsupported operations) are *values*, not exceptions: every capability
 * and service method returns `Result<T, AppError>` so the compiler forces the
 * caller to deal with the failure path. Exceptions are reserved for bugs.
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const andThen = <T, U, E, F>(r: Result<T, E>, f: (t: T) => Result<U, F>): Result<U, E | F> =>
  r.ok ? f(r.value) : r;

export const andThenAsync = async <T, U, E, F>(
  r: Result<T, E>,
  f: (t: T) => Promise<Result<U, F>>,
): Promise<Result<U, E | F>> => (r.ok ? f(r.value) : r);
