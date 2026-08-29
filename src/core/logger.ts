/** Structural subset of pino's logger (what Fastify hands us as `request.log`). */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
