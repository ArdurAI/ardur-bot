import type { HermesProviderFailure } from "@ardurbot/host-runtime/runtimes/hermes-provider-failure";
import { HermesProviderRelayError } from "@ardurbot/host-runtime/runtimes/hermes-provider-failure";

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

/** Observe only transport outcome. URLs, headers, bodies and causes never become diagnostics. */
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
      observe(upstreamHttpFailure(response.status));
    }
    return response;
  };
}
