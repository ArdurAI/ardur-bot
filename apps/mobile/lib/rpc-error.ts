/** An RPC failure that carries the server's error code, so callers can name a specific fix.
 * `code` is the ORPC status (e.g. "BAD_REQUEST", or a custom top-level code some routes use);
 * `data` is the error's own `data` payload, some routes' way of attaching a machine-readable
 * code such as `engine-missing` — read it with `errorDataCode` from `@ardurbot/contracts`. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
