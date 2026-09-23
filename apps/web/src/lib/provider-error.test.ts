import { describe, expect, it } from "vitest";
import { parseProviderError } from "./provider-error";

describe("parseProviderError", () => {
  const message =
    "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.";
  it.each([
    JSON.stringify({ detail: message }),
    JSON.stringify({ error: { message } }),
    JSON.stringify({ message }),
    message,
  ])("extracts the provider sentence from %s", (text) => {
    expect(parseProviderError(text)).toEqual({ message, kind: "model-unavailable" });
  });

  it.each(["UNKNOWN MODEL", "Model does not exist", "Model not available", "Model not found"])(
    "recognizes %s",
    (text) => expect(parseProviderError(text).kind).toBe("model-unavailable"),
  );

  it("keeps unrelated errors out of model recovery", () => {
    expect(parseProviderError('{"error":{"message":"Rate limit exceeded"}}')).toEqual({
      message: "Rate limit exceeded",
      kind: "other",
    });
  });

  it.each([
    "Image input is not supported by this connection.",
    "Tool calls are not available on this plan.",
    "This file type is unsupported.",
    "Model tool calls are not supported",
    "Model image input is not available",
    "Invalid model response JSON",
  ])("does not offer model recovery for an unrelated %s", (text) => {
    expect(parseProviderError(text).kind).toBe("other");
  });

  it.each([
    "",
    "null",
    "42",
    "[]",
    '{"detail":null}',
    '{"error":"failure"}',
    '{"message":42}',
    '{"detail":',
  ])("safely preserves unrecognized input %s", (text) => {
    expect(parseProviderError(text)).toEqual({ message: text, kind: "other" });
  });

  it("falls through non-string fields", () => {
    expect(parseProviderError('{"detail":42,"error":null,"message":"Try again"}')).toEqual({
      message: "Try again",
      kind: "other",
    });
  });
});

it("treats an explicit server kind as authoritative", () => {
  expect(parseProviderError("Model not supported", "rate-limit").kind).toBe("rate-limit");
  expect(parseProviderError("Model not supported", "other").kind).toBe("other");
  expect(parseProviderError("Access denied", "model-unavailable").kind).toBe("model-unavailable");
});
