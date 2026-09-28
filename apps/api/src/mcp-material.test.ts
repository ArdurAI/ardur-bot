import { describe, expect, it } from "vitest";
import { buildMcpUpdateMaterial, visibleMcpCredentialFlags } from "./mcp-material.js";

it("shows legacy entries as secret until their owner changes the flag", () => {
  expect(
    visibleMcpCredentialFlags({
      env: { LOG_LEVEL: "info", PGPASSWORD: "bluebird-42" },
      headers: { "X-Auth": "header-789" },
    }),
  ).toEqual({
    env: { LOG_LEVEL: true, PGPASSWORD: true },
    headers: { "X-Auth": true },
  });
});

describe("buildMcpUpdateMaterial", () => {
  it("defaults new plain names off while keeping legacy entries secret", () => {
    const result = buildMcpUpdateMaterial(
      { env: { PGPASSWORD: "bluebird-42" } },
      {
        transport: "stdio",
        slug: "x",
        name: "x",
        command: "/bin/mcp",
        env: {
          PGPASSWORD: "bluebird-42",
          LOG_LEVEL: "info",
          DEBUG: "1",
        },
      },
    );
    expect(result).toMatchObject({
      action: "store",
      material: {
        credentialFlags: { env: { PGPASSWORD: true, LOG_LEVEL: false, DEBUG: false }, headers: {} },
      },
    });
  });

  it("keeps the stored blob untouched when the update carries no credential data", () => {
    expect(
      buildMcpUpdateMaterial(
        {},
        {
          transport: "streamable_http",
          slug: "x",
          name: "x",
          endpoint: "https://mcp.example.test",
          headers: {},
        },
      ),
    ).toEqual({ action: "keep" });
  });

  it("stores a merged blob when a new secret is supplied, preserving OAuth state", () => {
    const existing = { secret: "old-token", oauth: { tokens: { access_token: "t" } } };
    const result = buildMcpUpdateMaterial(existing, {
      transport: "streamable_http",
      slug: "x",
      name: "x",
      endpoint: "https://mcp.example.test",
      headers: {},
      secret: "new-token",
    });
    expect(result).toEqual({
      action: "store",
      material: { secret: "new-token", oauth: { tokens: { access_token: "t" } } },
    });
  });

  it("persists env/headers even without any static secret (no silent drop)", () => {
    const result = buildMcpUpdateMaterial(
      {},
      {
        transport: "stdio",
        slug: "x",
        name: "x",
        command: "/bin/mcp",
        env: { API_KEY: "k" },
      },
    );
    expect(result).toEqual({
      action: "store",
      material: {
        env: { API_KEY: "k" },
        credentialFlags: { env: { API_KEY: true }, headers: {} },
      },
    });
  });

  it("clearing removes static credentials but keeps OAuth state", () => {
    const existing = { secret: "token", env: { A: "b" }, oauth: { tokens: { access_token: "t" } } };
    const result = buildMcpUpdateMaterial(existing, {
      transport: "streamable_http",
      slug: "x",
      name: "x",
      endpoint: "https://mcp.example.test",
      headers: {},
      clearCredential: true,
    });
    expect(result).toEqual({
      action: "store",
      material: { oauth: { tokens: { access_token: "t" } } },
    });
  });

  it("clearing with no OAuth state yields an empty blob so the caller can delete the secret row", () => {
    const result = buildMcpUpdateMaterial(
      { secret: "token" },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://mcp.example.test",
        headers: {},
        clearCredential: true,
      },
    );
    expect(result).toEqual({ action: "store", material: {} });
  });

  it("clears endpoint-bound OAuth state while preserving static credentials", () => {
    const result = buildMcpUpdateMaterial(
      { secret: "token", oauth: { tokens: { access_token: "endpoint-token" } } },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://new-mcp.example.test",
        headers: {},
      },
      { clearOAuth: true },
    );
    expect(result).toEqual({
      action: "store",
      material: { secret: "token", headers: {} },
    });
  });

  it("deletes an OAuth-only blob when its endpoint changes", () => {
    const result = buildMcpUpdateMaterial(
      { oauth: { tokens: { access_token: "endpoint-token" } } },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://new-mcp.example.test",
        headers: {},
      },
      { clearOAuth: true },
    );
    expect(result).toEqual({ action: "store", material: {} });
  });

  it("replaces headers on update and leaves env untouched when the transport cannot express it", () => {
    const result = buildMcpUpdateMaterial(
      { env: { OLD: "x" }, headers: { Authorization: "a" } },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://mcp.example.test",
        headers: { Authorization: "b" },
      },
    );
    expect(result).toEqual({
      action: "store",
      material: {
        env: { OLD: "x" },
        headers: { Authorization: "b" },
        credentialFlags: { env: { OLD: true }, headers: { Authorization: true } },
      },
    });
  });

  it("stores only the named header when a bearer secret is replaced", () => {
    const result = buildMcpUpdateMaterial(
      { secret: "old-bearer", oauth: { tokens: { access_token: "t" } } },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://mcp.example.test",
        headers: { "x-api-key": "new-key" },
      },
    );
    expect(result).toEqual({
      action: "store",
      material: {
        headers: { "x-api-key": "new-key" },
        credentialFlags: { env: {}, headers: { "x-api-key": true } },
        oauth: { tokens: { access_token: "t" } },
      },
    });
    expect(result.action === "store" && result.material).not.toHaveProperty("secret");
  });

  it("stores only the bearer when a named header is replaced, even if the old header is echoed", () => {
    const result = buildMcpUpdateMaterial(
      { secret: "old-bearer", headers: { "x-api-key": "old-key" } },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://mcp.example.test",
        headers: { "x-api-key": "old-key" },
        secret: "new-bearer",
      },
    );
    expect(result).toEqual({ action: "store", material: { secret: "new-bearer" } });
  });
});
