import { describe, expect, it } from "vitest";
import {
  argumentSecrets,
  McpLogBuffer,
  mcpTextContainsSecret,
  redactMcpArguments,
  redactMcpText,
} from "./mcp-diagnostics.js";

describe("MCP diagnostics", () => {
  it("redacts the exact tab-interleaved known-secret reproduction", () => {
    const secret = "sk-live-abc123XYZdef456ghi";
    const text = "err sk-liv\te-abc123XYZdef456ghi end";
    expect(redactMcpText(text, [secret])).toBe("err [redacted] end");
    expect(mcpTextContainsSecret(text, secret)).toBe(true);
  });

  it.each([
    "\t",
    "\n",
    "\v",
    "\f",
    "\r",
    " ",
    "\u0085",
    "\u00a0",
    "\u1680",
    "\u2000",
    "\u2001",
    "\u2002",
    "\u2003",
    "\u2004",
    "\u2005",
    "\u2006",
    "\u2007",
    "\u2008",
    "\u2009",
    "\u200a",
    "\u2028",
    "\u2029",
    "\u202f",
    "\u205f",
    "\u3000",
    "\u0301",
    "\u0903",
    "\u20dd",
    "\u{1d185}",
  ])(
    "matches known secrets through all Unicode whitespace and mark categories (%j)",
    (separator) => {
      const secret = "opaque-fixture-credential";
      const text = [...secret].join(separator);
      expect(redactMcpText(`before ${text} after`, [secret]).replace(/[\r\n]/g, "")).toBe(
        `before ${separator === "\r" || separator === "\n" ? "[redacted]".repeat(secret.length) : "[redacted]"} after`,
      );
      expect(mcpTextContainsSecret(text, secret)).toBe(true);
    },
  );

  it("matches known secrets across word boundaries without changing unrelated whitespace", () => {
    expect(redactMcpText("  before pass word after  ", ["password"])).toBe(
      "  before [redacted] after  ",
    );
    expect(mcpTextContainsSecret("pass word", "password")).toBe(true);
    const ordinary = "  before\tordinary\u00a0word\u2028after\u0301  ";
    expect(redactMcpText(ordinary, ["password", " \t\u0301"])).toBe(ordinary);
    expect(mcpTextContainsSecret(ordinary, " \t\u0301")).toBe(false);
  });

  it("maps offsets around supplementary characters and folds known spellings too", () => {
    expect(redactMcpText("😀 a\u{1d185}b\tc 😀", ["a b\u0301c"])).toBe("😀 [redacted] 😀");
    expect(redactMcpText("😀\t😀", ["😀😀"])).toBe("[redacted]");
  });

  it("folds long text linearly while preserving unrelated separators", () => {
    const ordinary = "ordinary\tword\u0301 ".repeat(100_000);
    const credential = "opaque/+credential";
    const interleaved = [...credential].join("\u00a0\u{1d185}");
    const started = performance.now();
    expect(redactMcpText(`${ordinary}${interleaved}`, [credential])).toBe(`${ordinary}[redacted]`);
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("keeps repeated matches linear even when another encoded spelling is absent", () => {
    const credential = "opaque/+credential";
    const text = `${[...credential].join("\t\u0301")} `.repeat(20_000);
    const started = performance.now();
    expect(redactMcpText(text, [credential])).toBe("[redacted] ".repeat(20_000));
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 10_000);

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
