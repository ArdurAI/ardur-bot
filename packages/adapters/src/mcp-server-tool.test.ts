import { describe, expect, it } from "vitest";
import {
  buildMcpCredentialBlob,
  deriveMcpSlug,
  needsOAuthProbe,
  parseMcpServerToolArgs,
} from "./mcp-server-tool.js";

describe("deriveMcpSlug", () => {
  it("slugifies server names like the settings overlay does", () => {
    expect(deriveMcpSlug("Brex MCP Server!")).toBe("brex-mcp-server");
    expect(deriveMcpSlug("  --  ")).toMatch(/^mcp-\d+$/);
    expect(deriveMcpSlug("x".repeat(100))).toHaveLength(64);
  });
});

describe("parseMcpServerToolArgs", () => {
  it("parses a minimal remote server", () => {
    const parsed = parseMcpServerToolArgs({
      name: "Brex",
      transport: "streamable_http",
      endpoint: "https://api.brex.example/mcp",
    });
    expect(parsed).toMatchObject({
      name: "Brex",
      transport: "streamable_http",
      endpoint: "https://api.brex.example/mcp",
      assignToSelf: true,
    });
    expect(parsed?.slug).toBe("brex");
  });

  it("rejects missing names, bad transports, and non-http endpoints", () => {
    expect(
      parseMcpServerToolArgs({ transport: "streamable_http", endpoint: "https://x.test" }),
    ).toBeUndefined();
    expect(parseMcpServerToolArgs({ name: "x", transport: "carrier-pigeon" })).toBeUndefined();
    expect(parseMcpServerToolArgs({ name: "x", transport: "streamable_http" })).toBeUndefined();
    expect(
      parseMcpServerToolArgs({ name: "x", transport: "streamable_http", endpoint: "ftp://x.test" }),
    ).toBeUndefined();
    expect(
      parseMcpServerToolArgs({
        name: "x",
        transport: "streamable_http",
        endpoint: "http://x.test",
      }),
    ).toBeUndefined();
    expect(
      parseMcpServerToolArgs({
        name: "x",
        transport: "streamable_http",
        endpoint: "https://user:password@x.test/mcp#fragment",
      }),
    ).toBeUndefined();
    expect(parseMcpServerToolArgs({ name: "x", transport: "stdio" })).toBeUndefined();
  });

  it("normalizes stdio commands and string args", () => {
    const parsed = parseMcpServerToolArgs({
      name: "Local",
      transport: "stdio",
      command: " /opt/mcp ",
      args: "--verbose --port 9",
    });
    expect(parsed).toMatchObject({
      transport: "stdio",
      command: "/opt/mcp",
      args: ["--verbose", "--port", "9"],
    });
  });

  it("keeps only string-valued env/headers entries and caps their size", () => {
    const parsed = parseMcpServerToolArgs({
      name: "H",
      transport: "sse",
      endpoint: "https://h.example.test",
      headers: { Authorization: "Bearer t", Broken: 42 as unknown as string },
      env: { A: "b", BAD: null as unknown as string },
    });
    expect(parsed?.headers).toEqual({ Authorization: "Bearer t" });
    expect(parsed?.env).toEqual({ A: "b" });

    const tooMany = parseMcpServerToolArgs({
      name: "H",
      transport: "stdio",
      command: "c",
      env: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, "v"])),
    });
    expect(tooMany).toBeUndefined();
  });
});

describe("buildMcpCredentialBlob", () => {
  it("rejects a token stored beside a named header", () => {
    expect(() =>
      buildMcpCredentialBlob({ secret: "tok", headers: { "X-Api-Key": "key" }, env: {} }),
    ).toThrow("Choose one credential: a token or a header.");
  });

  it("returns null when no credential material exists", () => {
    expect(buildMcpCredentialBlob({})).toBeNull();
    expect(buildMcpCredentialBlob({ headers: {}, env: {} })).toBeNull();
  });

  it("serializes one credential into the encrypted blob shape", () => {
    expect(buildMcpCredentialBlob({ secret: "tok", headers: {}, env: {} })).toEqual(
      JSON.stringify({ secret: "tok", env: {}, headers: {} }),
    );
    expect(buildMcpCredentialBlob({ headers: { "X-Api-Key": "key" }, env: { A: "b" } })).toEqual(
      JSON.stringify({ env: { A: "b" }, headers: { "X-Api-Key": "key" } }),
    );
  });
});

describe("needsOAuthProbe", () => {
  it("is true only for remote servers without static credentials", () => {
    expect(needsOAuthProbe({ transport: "streamable_http" })).toBe(true);
    expect(needsOAuthProbe({ transport: "sse" })).toBe(true);
    expect(needsOAuthProbe({ transport: "streamable_http", secret: "tok" })).toBe(false);
    expect(needsOAuthProbe({ transport: "streamable_http", headers: { Authorization: "x" } })).toBe(
      false,
    );
    expect(needsOAuthProbe({ transport: "stdio", command: "c" } as never)).toBe(false);
  });
});
