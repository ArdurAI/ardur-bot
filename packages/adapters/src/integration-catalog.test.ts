import { readdir, readFile } from "node:fs/promises";
import { IntegrationManifestSchema } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  connectableIntegration,
  integrationCatalog,
  validateIntegrationDescriptor,
} from "./integration-catalog.js";
import { captureIntegrationManifest, inputSchemaDigest } from "./integration-manifest.js";
import { assertSafeRemoteUrl } from "./remote-mcp.js";

describe("trusted integration registry", () => {
  it("has nine unique valid entries, four empty opt-in grants, and no embedded credentials", () => {
    expect(integrationCatalog).toHaveLength(9);
    expect(new Set(integrationCatalog.map((entry) => entry.id)).size).toBe(9);
    expect(integrationCatalog.filter((entry) => entry.available).map((entry) => entry.id)).toEqual([
      "github",
      "gitlab",
      "atlassian",
      "notion",
    ]);
    for (const descriptor of integrationCatalog) {
      expect(validateIntegrationDescriptor(descriptor)).toEqual(descriptor);
      expect(descriptor.defaultAllowedTools).toEqual([]);
      expect(descriptor.toolPolicies).toEqual({});
      expect(JSON.stringify(descriptor)).not.toMatch(
        /Bearer |"client_secret"\s*:|access_token|password/i,
      );
      if (!descriptor.available)
        expect(() => connectableIntegration(descriptor.id)).toThrow("not available");
    }
  });
  it("keeps Notion API metadata separate and defaults GitHub to a token", () => {
    expect(connectableIntegration("notion")).toMatchObject({
      endpoint: "https://mcp.notion.com/mcp",
      transport: "remote-http",
      authKind: "oauth",
      apiVersion: "2026-03-11",
      serverVersion: null,
    });
    expect(connectableIntegration("github")).toMatchObject({
      authKind: "token",
      tokenUrl: "https://github.com/settings/personal-access-tokens/new",
      oauthApp: {
        clientIdEnv: "GITHUB_MCP_CLIENT_ID",
        clientSecretEnv: "GITHUB_MCP_CLIENT_SECRET",
      },
    });
  });
  it("rejects credentials and invalid transports instead of silently stripping fields", () => {
    const descriptor = connectableIntegration("github");
    for (const patch of [
      { endpoint: "https://user:pass@example.test/mcp" },
      { endpoint: "https://example.test/mcp?token=fake" },
      { secret: "fake" },
      { endpoint: undefined },
      { launch: { command: "example", args: [] } },
    ])
      expect(() => validateIntegrationDescriptor({ ...descriptor, ...patch })).toThrow();
  });
  it("limits advanced hosts to GitLab and the documented path", async () => {
    expect(connectableIntegration("gitlab", "https://git.example.test").endpoint).toBe(
      "https://git.example.test/api/v4/mcp",
    );
    for (const host of [
      "http://git.example.test",
      "https://git.example.test/path",
      "https://user:pass@git.example.test",
      "https://git.example.test?token=fake",
    ])
      expect(() => connectableIntegration("gitlab", host)).toThrow();
    expect(() => connectableIntegration("github", "https://example.test")).toThrow();
    for (const descriptor of integrationCatalog.filter((entry) => entry.available)) {
      await expect(
        assertSafeRemoteUrl(descriptor.endpoint!, async () => [
          { address: "203.0.113.10", family: 4 },
        ]),
      ).resolves.toBeDefined();
      await expect(
        assertSafeRemoteUrl(descriptor.endpoint!, async () => [
          { address: "127.0.0.1", family: 4 },
        ]),
      ).rejects.toThrow();
    }
  });
});

describe("integration manifest capture", () => {
  it("hashes schemas canonically and keeps credentials, schemas and account data out", () => {
    expect(inputSchemaDigest({ a: 1, b: 2 })).toBe(inputSchemaDigest({ b: 2, a: 1 }));
    const manifest = captureIntegrationManifest(
      [
        {
          name: "synthetic_read",
          description:
            "Read fake-secret at https://private.example.test/a for example@example.test",
          inputSchema: { type: "object", default: "fake-secret" },
        },
      ],
      "1",
      ["fake-secret"],
    );
    expect(JSON.stringify(manifest)).not.toMatch(
      /fake-secret|private\.example|example@example|default/,
    );
    expect(manifest.account).toBeNull();
    expect(manifest.tools[0]?.inputSchemaDigest).toHaveLength(64);
    expect(() =>
      captureIntegrationManifest([{ name: "fake-secret", inputSchema: {} }], null, ["fake-secret"]),
    ).toThrow();
    expect(() =>
      captureIntegrationManifest(
        [
          { name: "same", inputSchema: {} },
          { name: "same", inputSchema: {} },
        ],
        null,
      ),
    ).toThrow();
  });
  it("loads captured fixtures when present, otherwise a clearly synthetic manifest", async () => {
    const directory = new URL("./__fixtures__/integrations/", import.meta.url);
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const fixtures = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const { vendor, ...manifest } = JSON.parse(
            await readFile(new URL(file, directory), "utf8"),
          );
          expect(integrationCatalog.some((entry) => entry.vendor === vendor)).toBe(true);
          return { ...manifest, account: null };
        }),
    );
    const synthetic = captureIntegrationManifest(
      [
        {
          name: "synthetic_read_item",
          description: "Synthetic fixture; not a vendor tool.",
          inputSchema: { type: "object" },
        },
      ],
      null,
    );
    for (const fixture of fixtures.length ? fixtures : [synthetic])
      expect(IntegrationManifestSchema.safeParse(fixture).success).toBe(true);
  });
});
