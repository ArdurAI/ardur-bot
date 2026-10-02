import { describe, expect, it } from "vitest";
import {
  argumentSecrets,
  McpLogBuffer,
  mcpTextContainsSecret,
  redactMcpArguments,
  redactMcpText,
} from "./mcp-diagnostics.js";

describe("MCP diagnostics", () => {
  it.each([
    "a\x1b[0mbc",
    "a\x1b[?25lbc",
    "a\x1b]0;fixture title\x07bc",
    "a\x1b]0;fixture title\x1b\\bc",
    "a\x1bMbc",
    "a\x1b(Bbc",
    "a\x00\x08\x7fbc",
    "a\u200b\u2060\ufeffbc",
    "a\u009b0mbc",
    "a\u009d0;fixture title\u009cbc",
  ])("normalizes terminal and invisible separators before matching secrets (%j)", (text) => {
    expect(redactMcpText(text, ["abc"])).toBe("[redacted]");
    expect(mcpTextContainsSecret(text, "abc")).toBe(true);
  });

  it.each([
    ["sk-fixture\x1b[0mSynthetic12345", "[redacted]"],
    ["Bearer fixture\x1b]0;title\x07OpaqueValue", "Bearer [redacted]"],
    ["sk-fixture\u200bSynthetic12345", "[redacted]"],
    ["Bearer fixture\x00OpaqueValue", "Bearer [redacted]"],
  ])("normalizes before general credential patterns without a known secret (%j)", (text, safe) => {
    expect(redactMcpText(text)).toBe(safe);
  });

  it("redacts split chunks before storage, retaining only the last 200 lines", () => {
    const ring = new McpLogBuffer(["fixture-secret"]);
    ring.append("token=fixture-");
    expect(ring.snapshot().lines).toEqual([]);
    ring.append("secret\n");
    expect(ring.snapshot().lines).toEqual(["token=[redacted]"]);
    for (let i = 0; i < 250; i++) ring.append(`${i}\n`);
    expect(ring.snapshot().lines).toHaveLength(200);
    expect(ring.snapshot().lines[0]).toBe("50");
  });
  it("bounds oversized lines and total bytes, with redacted error state", () => {
    const ring = new McpLogBuffer(["test-credential"]);
    ring.append("a".repeat(30_000));
    ring.append("test-credential\n");
    ring.status("error", new Error("first line\ntest-credential failed"));
    expect(ring.snapshot().lastError).toBe("[redacted] failed");
    expect(ring.snapshot().lines[0]).toBe("Log line exceeded the size limit.");
    for (let i = 0; i < 200; i++) ring.append(`${"a".repeat(2000)}\n`);
    expect(JSON.stringify(ring.snapshot()).length).toBeLessThan(100_000);
  });
  it("hides credential arguments and preserves ordinary arguments", () => {
    const args = ["server.js", "--token", "fixture", "--api-key=test", "--port", "9000"];
    expect(argumentSecrets(args)).toEqual(["fixture", "test"]);
    expect(redactMcpArguments(args)).toEqual([
      "server.js",
      "--token",
      "[redacted]",
      "--api-key=[redacted]",
      "--port",
      "9000",
    ]);
  });
  it("matches the same credential spellings that text redaction masks", () => {
    for (const [value, secret] of [
      ["synthetic-credential", "synthetic-credential"],
      ["synthetic%2Fcredential", "synthetic/credential"],
      ['synthetic\\"credential', 'synthetic"credential'],
    ] as const) {
      expect(mcpTextContainsSecret(value, secret)).toBe(true);
      expect(redactMcpText(value, [secret])).toBe("[redacted]");
    }
    expect(mcpTextContainsSecret("unrelated", "synthetic-credential")).toBe(false);
  });
});
