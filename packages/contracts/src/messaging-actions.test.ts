import { describe, expect, it } from "vitest";
import { looksLikeChatSecret } from "./messaging-actions.js";

describe("chat credential detection", () => {
  it.each(["", "+", "-", ".", "(", "'", '"', "\n", "\n+", "123", "+.-"])(
    "rejects a credential URL after prefix %j",
    (prefix) => {
      expect(looksLikeChatSecret(`${prefix}postgres://example:placeholder@example.test/db`)).toBe(
        true,
      );
    },
  );
  it.each(["x", "x-", "+.-", "123", "SECRET_", "eyJ-"])(
    "bounds scanning of long %s tokens",
    (token) => {
      const value = token.repeat(Math.ceil((128 * 1024) / token.length));
      const start = performance.now();
      expect(looksLikeChatSecret(value)).toBe(false);
      expect(performance.now() - start).toBeLessThan(1000);
    },
  );
  it.each([
    "password=placeholder",
    "API_KEY=placeholder",
    "AWS_SECRET_ACCESS_KEY=placeholder",
    "postgres://example:placeholder@example.test/db",
    "custom+scheme://example:placeholder@example.test/db",
    "--prefix_API_KEY_suffix=placeholder",
    "Bearer placeholder",
    "-----BEGIN PRIVATE KEY-----",
    `${"a".repeat(24)}.${"b".repeat(6)}.${"c".repeat(30)}`,
    `prefix-eyJ${"x".repeat(24)}.${"y".repeat(16)}.${"z".repeat(30)}`,
  ])("rejects a recognizable credential format", (text) => {
    expect(looksLikeChatSecret(text)).toBe(true);
  });
  it.each([
    "How do password managers work?",
    "Read example.txt",
    "allow:00000000-0000-0000-0000-000000000000",
  ])("allows ordinary discussion and opaque approval nonces", (text) => {
    expect(looksLikeChatSecret(text)).toBe(false);
  });
});
