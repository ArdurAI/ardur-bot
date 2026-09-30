import { expect, it } from "vitest";
import { classifyProviderError, ProviderError, providerRetryAfterMs } from "./provider-error.js";

it.each([
  ["Model gpt-6-astra is not available", "model-unavailable"],
  [
    JSON.stringify({
      detail:
        "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
    }),
    "model-unavailable",
  ],
  [{ error: { code: "model_not_found", message: "No access" } }, "model-unavailable"],
  [{ status: 401 }, "auth"],
  [new Error("Invalid API key"), "auth"],
  [{ status: 429, message: "Model not available" }, "rate-limit"],
  ["Rate limit exceeded", "rate-limit"],
  ["Claude usage limit reached", "rate-limit"],
  ["You're out of extra usage", "rate-limit"],
  ["Image input is not supported", "other"],
  ["Model tool calls are not supported", "other"],
  ["Model returned invalid JSON", "other"],
  [{ status: 404, message: "Endpoint not found" }, "other"],
  [null, "other"],
  [new ProviderError("Sanitized", "auth"), "auth"],
] as const)("classifies %j at the provider boundary", (error, expected) => {
  expect(classifyProviderError(error)).toBe(expected);
});

it("bounds malformed cyclic error payloads", () => {
  const error: { error?: unknown } = {};
  error.error = error;
  expect(classifyProviderError(error)).toBe("other");
});

it.each([
  ["a retry-after-ms header", { headers: new Headers({ "retry-after-ms": "1200" }) }, 1_200],
  ["a retry-after header in seconds", { headers: new Headers({ "retry-after": "2.5" }) }, 2_500],
  [
    "a retry-after HTTP date",
    { headers: new Headers({ "retry-after": "2030-01-01T00:00:00.500Z" }) },
    500,
    new Date("2030-01-01T00:00:00.000Z").getTime(),
  ],
  ["plain header maps", { headers: { "Retry-After": "3" } }, 3_000],
  ["a retryAfterMs field", { retryAfterMs: 7_000 }, 7_000],
  ["a numeric retryAfter field", { retryAfter: 4 }, 4_000],
  ["a string retryAfter field", { retryAfter: "1.5" }, 1_500],
  ["a nested provider error body", { error: { retryAfterMs: 900 } }, 900],
  ["a carried ProviderError", new ProviderError("Too many requests", "rate-limit", 2_100), 2_100],
  ["no wait the provider exposed", { status: 429, message: "Too many requests" }, undefined],
  ["a non-numeric header", { headers: new Headers({ "retry-after": "soon" }) }, undefined],
  ["a negative field", { retryAfterMs: -5 }, -5],
])(
  "reads the provider's own wait from %s",
  (_name, error, expected, now = new Date("2030-01-01T00:00:00.000Z").getTime()) => {
    expect(providerRetryAfterMs(error, now)).toBe(expected);
  },
);
