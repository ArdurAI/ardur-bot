import { expect, it } from "vitest";
import { classifyProviderError, ProviderError } from "./provider-error.js";

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
