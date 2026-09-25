import { setTimeout as delay } from "node:timers/promises";

export const CONSENT_TTL_MS = 10 * 60_000;
export const INTEGRATION_HEALTH_INTERVAL_MS = 30 * 60_000;

/** Keep provider prose and response bodies out of persisted errors. */
export function integrationFailure(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "MCP_REAUTHORIZATION_REQUIRED")
    return error instanceof Error ? error.message : "Needs sign-in.";
  if (code === "MCP_OAUTH_UNAVAILABLE") return "Needs sign-in (oauth_unavailable).";
  return "Could not reach this integration. Try again.";
}

export function transientIntegrationError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return true;
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  return [408, 429, 500, 502, 503, 504, "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(
    code as number | string,
  );
}

/** Only call this around idempotent reads, never around an uncertain tool write. */
export async function retryIntegrationRead<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
  wait: (ms: number) => Promise<unknown> = (ms) => delay(ms, undefined, { signal }),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      if (attempt >= 2 || !transientIntegrationError(error)) throw error;
      await wait(250 * 2 ** attempt);
    }
  }
}
