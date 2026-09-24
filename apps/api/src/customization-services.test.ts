// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Literal plugin protocol variables.
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EncryptedSecretStore } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { ManagedServerInputSchema } from "@ardurbot/contracts";
import { memoryServiceFixture } from "@ardurbot/testkit/memory-fakes";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCustomizationPlugins, resolvePluginVariables } from "./customization-plugins.js";
import { createCustomizationRoutes } from "./customization-routes.js";
import { createCustomizationSkills, customizationCatalog } from "./customization-skills.js";
import { configDiff, createMcpSettings, parseServerConfig } from "./mcp-settings.js";
import type { RouterDeps } from "./router.js";

const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
type Row = Record<string, unknown>;
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const filter = value as Row;
      if ("in" in filter) return (filter.in as unknown[]).includes(row[key]);
      if ("startsWith" in filter) return String(row[key]).startsWith(String(filter.startsWith));
      if ("equals" in filter)
        return String(row[key]).toLowerCase() === String(filter.equals).toLowerCase();
      if ("not" in filter) return row[key] !== filter.not;
    }
    return row[key] === value;
  });
}
async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ardur-customization-test-"));
  roots.push(dataDir);
  const tables: Record<string, Row[]> = {};
  const prisma: Record<string, unknown> = { $executeRaw: vi.fn(async () => 1) };
  for (const name of [
    "agentSkill",
    "taughtSkill",
    "mcpServer",
    "secret",
    "pluginInstall",
    "customizationMarketplace",
  ]) {
    const rows: Row[] = [];
    tables[name] = rows;
    const update = (row: Row, data: Row) => {
      for (const [key, value] of Object.entries(data))
        row[key] =
          value && typeof value === "object" && "increment" in value
            ? Number(row[key]) + Number(value.increment)
            : value;
      return row;
    };
    prisma[name] = {
      findMany: vi.fn(async ({ where = {} } = {}) =>
        rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
      ),
      findFirst: vi.fn(async ({ where = {} } = {}) => {
        const row = rows.find((row) => matches(row, where));
        return row ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }) => {
        const row = {
          id: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          enabled: true,
          state: "installing",
          componentKind: "skill",
          botId: null,
          pluginId: null,
          bundleId: null,
          source: "user",
          origin: "user",
          args: [],
          env: {},
          headers: {},
          endpoint: null,
          secretId: null,
          revision: 1,
          managedBy: null,
          managedId: null,
          placement: "worker",
          diagnostics: {},
          catalogId: null,
          connectionState: "not-connected",
          ...data,
        };
        rows.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = rows.find((row) => matches(row, where));
        if (!row) throw new Error("Missing row");
        return { ...update(row, data) };
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const selected = rows.filter((row) => matches(row, where));
        selected.forEach((row) => {
          update(row, data);
        });
        return { count: selected.length };
      }),
      delete: vi.fn(async ({ where }) => {
        const i = rows.findIndex((row) => matches(row, where));
        if (i < 0) throw new Error("Missing row");
        return rows.splice(i, 1)[0];
      }),
      deleteMany: vi.fn(async ({ where }) => {
        const selected = rows.filter((row) => matches(row, where));
        selected.forEach((row) => {
          rows.splice(rows.indexOf(row), 1);
        });
        return { count: selected.length };
      }),
      count: vi.fn(async ({ where }) => rows.filter((row) => matches(row, where)).length),
    };
  }
  prisma.$transaction = vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma));
  const deps = {
    prisma,
    secrets: new EncryptedSecretStore("fixture-encryption-material"),
    memoryDocuments: memoryServiceFixture({ ...actor, botId: "bot" }).service,
    dataDir,
    env: { webOrigin: "https://app.example.test" },
  } as unknown as RouterDeps;
  return {
    deps,
    tables,
    mcp: createMcpSettings(deps),
    skills: createCustomizationSkills(deps),
    plugins: createCustomizationPlugins(deps),
  };
}
describe("customization service boundaries", () => {
  it("stores managed launch values encrypted and preserves a scoped registration across retries", async () => {
    const f = await fixture();
    const input = ManagedServerInputSchema.parse({
      managedId: "fixture",
      managedBy: "extension",
      name: "Fixture",
      description: "",
      placement: "worker",
      command: "node",
      args: ["server.js", "private-value"],
      env: { TOKEN: "private-value" },
      secretValues: ["private-value"],
      cwd: "/fixture/bundle",
    });
    const first = await f.mcp.register(actor, input);
    expect(await f.mcp.register(actor, input)).toEqual(first);
    expect(f.tables.mcpServer).toHaveLength(1);
    expect(JSON.stringify(f.tables)).not.toContain("private-value");
    expect((await f.mcp.list(actor))[0]?.args).toEqual(["server.js", "[redacted]"]);
    await f.mcp.removeManaged(
      { ...actor, userId: "different" },
      { managedId: "fixture", managedBy: "extension" },
    );
    expect(f.tables.mcpServer).toHaveLength(1);
    await f.mcp.removeManaged(actor, { managedId: "fixture", managedBy: "extension" });
    expect(f.tables.mcpServer).toHaveLength(0);
    expect(f.tables.secret).toHaveLength(0);
  });
  it("validates and previews config without leaking secrets, and fences stale applies", async () => {
    const f = await fixture();
    const initial = await f.mcp.config(actor);
    const json = JSON.stringify({
      mcpServers: {
        fixture: {
          name: "Fixture",
          command: "node",
          args: ["server.js", "private-value"],
          env: { TOKEN: "private-value" },
        },
      },
    });
    const preview = await f.mcp.preview(actor, { json, revision: initial.revision });
    expect(JSON.stringify(preview)).not.toContain("private-value");
    await f.mcp.apply(actor, preview.id);
    let exported = await f.mcp.config(actor);
    expect(exported.json).toContain("[saved]");
    expect(exported.json).not.toContain("private-value");
    const withoutEnvironment = JSON.parse(exported.json);
    withoutEnvironment.mcpServers.fixture.env = {};
    const removal = await f.mcp.preview(actor, {
      json: JSON.stringify(withoutEnvironment),
      revision: exported.revision,
    });
    expect(JSON.stringify(removal)).not.toContain("private-value");
    await f.mcp.apply(actor, removal.id);
    expect(JSON.stringify(f.tables)).not.toContain("private-value");
    exported = await f.mcp.config(actor);
    expect(exported.json).not.toContain("private-value");
    const next = await f.mcp.preview(actor, {
      json: exported.json.replace('"Fixture"', '"Updated"'),
      revision: exported.revision,
    });
    f.tables.mcpServer![0]!.revision = 5;
    await expect(f.mcp.apply(actor, next.id)).rejects.toThrow("changed");
    expect(() => parseServerConfig('{"mcpServers":{"../bad":{"command":"node"}}}')).toThrow();
    const before = parseServerConfig(json);
    expect(configDiff(before, before)).toEqual([]);
  });
  it("imports file skills and lists file, taught and learned kinds with runtime enablement", async () => {
    const f = await fixture();
    await f.skills.import(actor, [
      {
        path: "fixture/SKILL.md",
        bytes: Buffer.from(
          "---\nname: Fixture\ndescription: Fixture recipe\n---\nFollow these steps.",
        ),
      },
    ]);
    const file = (await f.skills.list(actor))[0]!;
    f.tables.agentSkill!.push({
      ...f.tables.agentSkill![0],
      id: "learned",
      name: "Learned",
      source: "learned",
      origin: "learned",
      botId: "bot",
      documentId: null,
      content: "---\nname: Learned\ndescription: Learned recipe\n---\nSteps.",
    });
    f.tables.taughtSkill!.push({
      ...actor,
      id: "taught",
      botId: "bot",
      name: "Taught",
      goal: "Demo recipe",
      status: "saved",
      enabled: true,
      documentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect((await f.skills.list(actor)).map((row) => row.kind).sort()).toEqual([
      "file",
      "learned",
      "taught",
    ]);
    await f.skills.setEnabled(actor, { id: file.id, kind: "file", enabled: false });
    expect(f.tables.agentSkill![0]?.enabled).toBe(false);
    expect(customizationCatalog.skills).toHaveLength(1);
    await expect(
      f.skills.setEnabled(
        { ...actor, spaceId: "foreign" },
        { id: file.id, kind: "file", enabled: true },
      ),
    ).rejects.toThrow();
  });
  it("requires a scoped preview and materializes and removes only a plugin's components", async () => {
    const f = await fixture();
    const preview = await f.plugins.preview(actor, { name: "review-kit", catalogId: "review-kit" });
    expect(preview.summary.skills).toHaveLength(1);
    expect(preview.summary.commands).toHaveLength(1);
    await expect(f.plugins.install({ ...actor, userId: "foreign" }, preview.id)).rejects.toThrow();
    const plugin = await f.plugins.install(actor, preview.id);
    expect((await f.plugins.list(actor)).installs).toHaveLength(1);
    expect(f.tables.agentSkill?.map((row) => [row.componentKind, row.enabled])).toEqual([
      ["skill", true],
      ["command", true],
    ]);
    f.tables.agentSkill!.push({ id: "unrelated", ...actor });
    await f.plugins.uninstall(actor, plugin.id);
    expect(f.tables.agentSkill).toEqual([{ id: "unrelated", ...actor }]);
    expect((await f.plugins.list(actor)).installs).toEqual([]);
    const dirs = await readdir(path.join(f.deps.dataDir, "plugins"));
    expect(await readdir(path.join(f.deps.dataDir, "plugins", dirs[0]!))).toEqual([]);
    expect(resolvePluginVariables("${CLAUDE_PLUGIN_ROOT}/server.js", "/fixture")).toBe(
      "/fixture/server.js",
    );
    expect(() => resolvePluginVariables("${UNKNOWN}", "/fixture")).toThrow();
  });
  it("installs a marketplace snapshot with encrypted MCP configuration and removes it completely", async () => {
    const f = await fixture();
    const file = (path: string, value: unknown) => ({
      path,
      bytes: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
    });
    const marketplace = await f.plugins.addMarketplace(actor, {
      files: [
        file(".claude-plugin/marketplace.json", {
          name: "fixture-market",
          owner: { name: "Fixture publisher" },
          plugins: [{ name: "fixture", source: "./plugins/fixture", category: "Review" }],
        }),
        file("plugins/fixture/.claude-plugin/plugin.json", { name: "fixture" }),
        file("plugins/fixture/.mcp.json", {
          mcpServers: {
            fixture: {
              command: "node",
              args: ["${CLAUDE_PLUGIN_ROOT}/server.js"],
              env: { TOKEN: "fixture-private-token" },
            },
          },
        }),
        file("plugins/fixture/server.js", "fixture"),
        file("plugins/fixture/commands/review.md", "Review input."),
        file("plugins/fixture/output-styles/brief.md", "Keep responses brief."),
      ],
    });
    const preview = await f.plugins.preview(actor, {
      name: "fixture",
      marketplaceId: marketplace.id,
    });
    expect(preview.summary).toMatchObject({
      servers: ["fixture"],
      commands: ["commands/review.md"],
      instructions: ["output-styles/brief.md"],
    });
    expect(JSON.stringify(f.tables)).not.toContain("fixture-private-token");
    const decoded = f.plugins
      .files(actor, preview.id)
      .map((entry) => Buffer.from(entry.content, "base64").toString())
      .join("\n");
    expect(decoded).not.toContain("fixture-private-token");
    const plugin = await f.plugins.install(actor, preview.id);
    expect(f.tables.mcpServer![0]).toMatchObject({
      enabled: true,
      managedBy: "plugin",
      pluginId: plugin.id,
      env: { TOKEN: true },
    });
    expect(JSON.stringify(f.tables)).not.toContain("fixture-private-token");
    await expect(f.plugins.removeMarketplace(actor, marketplace.id)).rejects.toThrow();
    await f.plugins.uninstall(actor, plugin.id);
    expect(f.tables.mcpServer).toEqual([]);
    await f.plugins.removeMarketplace(actor, marketplace.id);
    expect(f.tables.secret).toEqual([]);
  });
  it("counts only the owner's enabled connections needing reconnection through the public RPC", async () => {
    const f = await fixture();
    f.tables.mcpServer!.push(
      { id: "failed", ...actor, enabled: true, connectionState: "discovery-failed" },
      { id: "expired", ...actor, enabled: true, connectionState: "connected" },
      { id: "disabled", ...actor, enabled: false, connectionState: "discovery-failed" },
      {
        id: "foreign",
        ...actor,
        userId: "another",
        enabled: true,
        connectionState: "discovery-failed",
      },
    );
    f.deps.mcpOAuth = {
      statusFor: vi.fn(async (row: { id: string }) =>
        row.id === "expired" ? "reconnect" : "none",
      ),
    } as unknown as RouterDeps["mcpOAuth"];
    const handler = new RPCHandler(createCustomizationRoutes(f.deps));
    const call = (owner: Actor | null) =>
      handler.handle(
        new Request("https://app.example.test/rpc/connectors/summary", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: {} }),
        }),
        { prefix: "/rpc", context: { actor: owner } },
      );
    expect(await (await call(actor)).response?.json()).toEqual({
      json: { needingReconnection: 2 },
    });
    expect((await call(null)).response?.status).toBe(401);
  });
  it("rolls back files and plugin metadata when a memory component cannot be committed", async () => {
    const f = await fixture();
    const preview = await f.plugins.preview(actor, { name: "review-kit", catalogId: "review-kit" });
    vi.spyOn(f.deps.memoryDocuments!, "commit").mockRejectedValueOnce(
      new Error("Fixture memory unavailable"),
    );
    await expect(f.plugins.install(actor, preview.id)).rejects.toThrow("memory unavailable");
    expect(f.tables.pluginInstall).toEqual([]);
    expect(f.tables.agentSkill).toEqual([]);
    expect(f.tables.mcpServer).toEqual([]);
  });
});
