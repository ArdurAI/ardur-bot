import { describe, expect, it } from "vitest";
import { looksLikeChatSecret } from "./messaging-actions.js";

describe("chat credential detection", () => {
  it.each([
    "password=placeholder",
    "API_KEY=placeholder",
    "AWS_SECRET_ACCESS_KEY=placeholder",
    "postgres://example:placeholder@example.test/db",
    "Bearer placeholder",
    "-----BEGIN PRIVATE KEY-----",
    `${"a".repeat(24)}.${"b".repeat(6)}.${"c".repeat(30)}`,
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
