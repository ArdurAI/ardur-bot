/** An RPC failure that carries the server's error code, so callers can name a specific fix. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
