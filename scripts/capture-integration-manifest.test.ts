import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { integrationCatalog } from "../packages/adapters/src/integration-catalog.js";
import { captureIntegrationManifest } from "../packages/adapters/src/integration-manifest.js";
import { captureManifest, proposedToolPolicies } from "./capture-integration-manifest.js";

const db = vi.hoisted(() => ({
  prisma: { mcpServer: { findUnique: vi.fn() }, $disconnect: vi.fn() },
  pool: { end: vi.fn() },
}));
vi.mock("../packages/db/src/index.js", () => ({ createDb: () => db }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// Synthetic fixtures only; no vendor tool names are asserted.
const manifest = captureIntegrationManifest(
  [
    { name: "synthetic_get_item", description: "Read an item", inputSchema: { type: "object" } },
    { name: "synthetic_list_items", description: "List items", inputSchema: { type: "object" } },
    {
      name: "synthetic_create_item",
      description: "Create an item",
      inputSchema: { type: "object" },
    },
    {
      name: "synthetic_get_and_delete",
      description: "Read and delete",
      inputSchema: { type: "object" },
    },
    { name: "synthetic_opaque", description: "Unknown", inputSchema: { type: "object" } },
  ],
  "synthetic",
);

describe("manifest review proposals", () => {
  it("proposes only read-classified captured ids, without treating classification as review", () => {
    expect(proposedToolPolicies(manifest)).toEqual({
      synthetic_get_item: { risk: "reviewed-read", approval: "allow" },
      synthetic_list_items: { risk: "reviewed-read", approval: "allow" },
    });
    expect(proposedToolPolicies({ ...manifest, tools: [] })).toEqual({});
  });
  it("prints a pasteable toolPolicies block and writes only the sanitized fixture", async () => {
    const before = structuredClone(integrationCatalog);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    db.prisma.mcpServer.findUnique.mockResolvedValue({
      catalogId: "github",
      enabled: true,
      connectionState: "connected",
      manifest: { ...manifest, account: "synthetic-private-account" },
    });
    await captureManifest("synthetic-connection", "synthetic-database-url");
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({
      toolPolicies: proposedToolPolicies(manifest),
    });
    expect(log.mock.calls.flat().join("\n")).toContain("Review each captured tool");
    expect(log.mock.calls.flat().join("\n")).not.toContain("synthetic-private-account");
    expect(log.mock.calls.flat().join("\n")).not.toContain("synthetic-database-url");
    expect(writeFile).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/__fixtures__\/integrations\/github-\d{4}-\d{2}-\d{2}\.json$/),
      expect.any(String),
      { flag: "wx", mode: 0o600 },
    );
    const fixture = JSON.parse(vi.mocked(writeFile).mock.calls[0]![1] as string);
    expect(fixture).toEqual({
      vendor: "github",
      capturedAt: manifest.capturedAt,
      serverVersion: manifest.serverVersion,
      tools: manifest.tools,
    });
    expect(integrationCatalog).toEqual(before);
    expect(db.prisma.$disconnect).toHaveBeenCalledOnce();
    expect(db.pool.end).toHaveBeenCalledOnce();
  });
  it("requires a connected, captured connection and cleans up after failure", async () => {
    db.prisma.mcpServer.findUnique.mockResolvedValue({ enabled: false });
    await expect(captureManifest("synthetic-connection", "synthetic-database-url")).rejects.toThrow(
      "connected",
    );
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(db.pool.end).toHaveBeenCalledOnce();
  });
});
