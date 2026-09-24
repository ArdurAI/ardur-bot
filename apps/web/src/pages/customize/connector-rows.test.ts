import type { IntegrationConnection, IntegrationDescriptor, McpServer } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { connectorRows } from "./connector-rows";

const server = (id: string, input: Partial<McpServer> = {}): McpServer => ({
  id,
  name: id,
  slug: id,
  spaceId: "space-fixture",
  description: "",
  transport: "streamable_http",
  endpoint: "https://example.test/mcp",
  command: null,
  args: [],
  envKeys: [],
  headerKeys: [],
  hasSecret: false,
  oauthStatus: "none",
  enabled: true,
  revision: 1,
  createdAt: "2026-09-24T00:00:00Z",
  updatedAt: "2026-09-24T00:00:00Z",
  ...input,
});
const catalog = [
  { id: "fixture-catalog", name: "Included service", transport: "remote-http", available: true },
  { id: "local-fixture", name: "Local service", transport: "stdio", available: false },
] as IntegrationDescriptor[];
describe("connector table data", () => {
  it("derives Web/Desktop and Included/Custom/Local dev without labeling managed servers as development servers", () => {
    const rows = connectorRows({
      catalog,
      connections: [
        {
          id: "included",
          catalogId: "fixture-catalog",
          state: "connected",
        } as IntegrationConnection,
      ],
      servers: [
        server("included"),
        server("custom"),
        server("development", { transport: "stdio" }),
        { ...server("extension", { transport: "stdio" }), managedBy: "extension" },
      ],
    });
    expect(rows.map(({ type, badges }) => ({ type, badges }))).toEqual([
      { type: "web", badges: ["included"] },
      { type: "web", badges: ["custom"] },
      { type: "desktop", badges: ["custom", "local-dev"] },
      { type: "desktop", badges: [] },
    ]);
  });
  it("does not treat a saved token as proof of a connection and prioritizes reconnection", () => {
    const rows = connectorRows({
      catalog,
      connections: [],
      servers: [
        server("saved-token", { hasSecret: true }),
        server("oauth", { oauthStatus: "connected" }),
        server("expired", { oauthStatus: "reconnect" }),
        server("disabled", { enabled: false, oauthStatus: "connected" }),
      ],
    });
    expect(rows.map((row) => row.status)).toEqual([
      "disconnected",
      "connected",
      "reconnect",
      "disconnected",
    ]);
  });
  it("lists only trusted descriptors in Catalog and preserves their live state", () => {
    const rows = connectorRows({
      catalog,
      connections: [
        { id: "known", catalogId: "fixture-catalog", state: "connected" } as IntegrationConnection,
      ],
      servers: [server("known"), server("custom")],
      catalogTab: true,
    });
    expect(rows.map((row) => row.id)).toEqual(["known", "catalog:local-fixture"]);
    expect(rows[0]?.status).toBe("connected");
    expect(rows[1]).toMatchObject({ type: "desktop", available: false, status: "disconnected" });
  });
});
