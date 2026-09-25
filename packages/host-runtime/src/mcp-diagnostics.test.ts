import { describe, expect, it } from "vitest";
import { argumentSecrets, McpLogBuffer, redactMcpArguments } from "./mcp-diagnostics.js";

describe("MCP diagnostics", () => {
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
});
