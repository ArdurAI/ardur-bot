import type { HermesProviderFailure } from "@ardurbot/host-runtime/runtimes/hermes-provider-failure";
import {
  HERMES_PROVIDER_REASON_CODES,
  HermesProviderRelayError,
} from "@ardurbot/host-runtime/runtimes/hermes-provider-failure";

/** Classify the actual HTTP response, not words in a vendor exception. No body is read. */
export function upstreamHttpFailure(status: number): HermesProviderFailure {
  return {
    kind: "provider-http",
    status,
    layer: "upstream",
    reason:
      status === 401 || status === 403
        ? "http-auth"
        : status === 429
          ? "http-rate-limit"
          : status >= 500
            ? "http-server"
            : status >= 400
              ? "http-client"
              : "http-other",
  };
}

/** Read a bounded clone; only known public codes can leave this function. */
async function providerReasonCode(response: Response) {
  // Read codes only for provider refusal statuses. Other failures, particularly 5xx,
  // can be classified from the status without waiting for an optional error body.
  if (![400, 401, 403, 429].includes(response.status)) return undefined;
  if (!response.headers.get("content-type")?.includes("application/json")) return undefined;
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), 1_000);
  });
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 4_096) return undefined;
      chunks.push(next.value);
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!payload || typeof payload !== "object" || !("error" in payload)) return undefined;
    const error = payload.error;
    if (!error || typeof error !== "object" || !("code" in error)) return undefined;
    // Never coerce objects or retain arbitrary code strings (which may contain secrets).
    const code = typeof error.code === "number" ? String(error.code) : error.code;
    return HERMES_PROVIDER_REASON_CODES.find((known) => known === code);
  };
  try {
    return await Promise.race([read().catch(() => undefined), deadline]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

/** URLs, headers, error messages and bodies never become diagnostics. */
export function diagnosticProviderFetch(
  transport: typeof globalThis.fetch,
  observe: (failure: HermesProviderFailure | undefined) => void,
): typeof globalThis.fetch {
  return async (input, init) => {
    observe(undefined);
    let response: Response;
    try {
      response = await transport(input, init);
    } catch {
      const failure = {
        kind: "provider-failed",
        layer: "provider-transport",
        reason: "transport",
      } as const;
      observe(failure);
      throw new HermesProviderRelayError(failure);
    }
    if (!response.ok) {
      const reasonCode = await providerReasonCode(response);
      observe({
        ...upstreamHttpFailure(response.status),
        ...(reasonCode ? { reasonCode } : {}),
      });
    }
    return response;
  };
}
