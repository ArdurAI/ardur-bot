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
import { authorizeHostMcp } from "./host-mcp-authorization.js";
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
  vi.restoreAllMocks();
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
  let transactionActive = false;
  prisma.$transaction = vi.fn(async (callback: (tx: unknown) => unknown) => {
    transactionActive = true;
    try {
      return await callback(prisma);
    } finally {
      transactionActive = false;
    }
  });
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
    get transactionActive() {
      return transactionActive;
    },
    mcp: createMcpSettings(deps),
    skills: createCustomizationSkills(deps),
    plugins: createCustomizationPlugins(deps),
  };
}
async function hostFixture() {
  const f = await fixture();
  f.tables.mcpServer!.push({
    ...actor,
    id: "running",
    slug: "running",
    name: "Running",
    description: "",
    transport: "stdio",
    placement: "host",
    revision: 1,
    enabled: true,
    command: "node",
    args: [],
    secretId: null,
    managedBy: null,
    catalogId: null,
  });
  const stop = vi.fn(async () => ({}));
  f.deps.hostBridge = {
    status: vi.fn(async () => ({ configured: true, connected: true })),
    result: stop,
  } as unknown as RouterDeps["hostBridge"];
  f.deps.prisma.deploymentSettings = {
    findUnique: vi.fn(async () => ({ ownerUserId: actor.userId })),
  } as unknown as RouterDeps["prisma"]["deploymentSettings"];
  return { f, stop };
}
describe("customization service boundaries", () => {
  it("isolates plugin preview capacity by user and space and expires pending previews", async () => {
    const f = await fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const input = { name: "review-kit", catalogId: "review-kit" };
    const pending = await Promise.all(
      Array.from({ length: 16 }, () => f.plugins.preview(actor, input)),
    );
    await expect(f.plugins.preview(actor, input)).rejects.toThrow("pending plugin install");
    for (const owner of [
      { ...actor, userId: "other" },
      { ...actor, spaceId: "other" },
    ]) {
      await expect(f.plugins.preview(owner, input)).resolves.toHaveProperty("id");
      expect(() => f.plugins.files(owner, pending[0]!.id)).toThrow();
    }
    clock.mockReturnValue(15 * 60_000);
    expect(() => f.plugins.files(actor, pending[0]!.id)).toThrow();
    await expect(f.plugins.preview(actor, input)).resolves.toHaveProperty("id");
  });
  it("isolates MCP preview capacity by user and space and expires pending previews", async () => {
    const f = await fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const config = await f.mcp.config(actor);
    const pending = await Promise.all(
      Array.from({ length: 128 }, () => f.mcp.preview(actor, config)),
    );
    await expect(f.mcp.preview(actor, config)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    for (const owner of [
      { ...actor, userId: "other" },
      { ...actor, spaceId: "other" },
    ]) {
      await expect(f.mcp.preview(owner, config)).resolves.toHaveProperty("id");
      await expect(f.mcp.apply(owner, pending[0]!.id)).rejects.toThrow();
    }
    clock.mockReturnValue(10 * 60_000);
    await expect(f.mcp.apply(actor, pending[0]!.id)).rejects.toThrow();
    await expect(f.mcp.preview(actor, config)).resolves.toHaveProperty("id");
  });
  it("rejects stale MCP applies before stopping any running host server", async () => {
    const f = await fixture();
    f.tables.mcpServer!.push({
      ...actor,
      id: "running",
      slug: "running",
      name: "Running",
      description: "",
      transport: "stdio",
      placement: "host",
      revision: 1,
      enabled: true,
      command: "node",
      args: [],
      secretId: null,
      managedBy: null,
      catalogId: null,
    });
    const stop = vi.fn(async () => ({}));
    f.deps.hostBridge = {
      status: vi.fn(async () => ({ connected: true })),
      result: stop,
    } as unknown as RouterDeps["hostBridge"];
    const preview = await f.mcp.preview(actor, await f.mcp.config(actor));
    f.tables.mcpServer![0]!.revision = 2;
    await expect(f.mcp.apply(actor, preview.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(stop).not.toHaveBeenCalled();
    expect(f.tables.mcpServer![0]).toMatchObject({ enabled: true, revision: 2 });
    const fresh = await f.mcp.preview(actor, await f.mcp.config(actor));
    stop.mockImplementationOnce(async () => {
      expect(f.deps.prisma.$executeRaw).toHaveBeenCalled();
      expect(f.transactionActive).toBe(false);
      expect(f.tables.mcpServer![0]).toMatchObject({ revision: 3, enabled: false });
      return {};
    });
    await f.mcp.apply(actor, fresh.id);
    expect(stop).toHaveBeenCalledExactlyOnceWith(
      { op: "mcp.stop", serverId: "running", revision: 3 },
      expect.objectContaining({ userId: actor.userId, spaceId: actor.spaceId }),
    );
  });
  it.each(["host", "worker", "remove"] as const)(
    "commits before a slow host shutdown and keeps its stop authorized when applying %s",
    async (placement) => {
      const { f, stop } = await hostFixture();
      const config = await f.mcp.config(actor);
      const preview = await f.mcp.preview(actor, {
        ...config,
        ...(placement === "remove" ? { json: '{"mcpServers":{}}' } : {}),
      });
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      stop.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return {};
      });
      const applying = f.mcp.apply(actor, preview.id, placement === "host" ? "host" : "worker");
      await started.promise;
      try {
        expect(f.transactionActive).toBe(false);
        expect(f.tables.mcpServer![0]).toMatchObject({
          enabled: false,
          revision: 2,
          placement: "host",
        });
        expect(
          await authorizeHostMcp(
            f.deps.prisma,
            {
              v: 1,
              type: "request",
              id: "stop",
              scope: {
                userId: actor.userId,
                spaceId: actor.spaceId,
                botId: "settings",
                runId: "stop",
              },
              operation: { op: "mcp.stop", serverId: "running", revision: 2 },
            },
            true,
          ),
        ).toBe(true);
        expect(stop).toHaveBeenCalledWith(
          { op: "mcp.stop", serverId: "running", revision: 2 },
          expect.anything(),
        );
      } finally {
        release.resolve();
        await applying;
      }
      if (placement === "remove") expect(f.tables.mcpServer).toHaveLength(0);
      else expect(f.tables.mcpServer![0]).toMatchObject({ enabled: true, revision: 3, placement });
    },
  );
  it("compensates a failed host shutdown without restoring the old revision", async () => {
    const { f, stop } = await hostFixture();
    const preview = await f.mcp.preview(actor, await f.mcp.config(actor));
    stop.mockRejectedValueOnce(new Error("Host stop failed"));
    await expect(f.mcp.apply(actor, preview.id, "host")).rejects.toThrow("Host stop failed");
    expect(f.tables.mcpServer![0]).toMatchObject({
      enabled: true,
      revision: 3,
      command: "node",
      placement: "host",
    });
    expect(f.tables.secret).toHaveLength(0);
  });
  it("does not overwrite a concurrent configuration change during shutdown compensation", async () => {
    const { f, stop } = await hostFixture();
    const preview = await f.mcp.preview(actor, await f.mcp.config(actor));
    stop.mockImplementationOnce(async () => {
      Object.assign(f.tables.mcpServer![0]!, { enabled: false, revision: 7 });
      throw new Error("Host stop failed");
    });
    await expect(f.mcp.apply(actor, preview.id, "host")).rejects.toThrow("Host stop failed");
    expect(f.tables.mcpServer![0]).toMatchObject({ enabled: false, revision: 7 });
  });
  it("revalidates the configuration after shutdown before applying the preview", async () => {
    const { f, stop } = await hostFixture();
    const preview = await f.mcp.preview(actor, await f.mcp.config(actor));
    stop.mockImplementationOnce(async () => {
      Object.assign(f.tables.mcpServer![0]!, { enabled: false, revision: 7 });
      return {};
    });
    await expect(f.mcp.apply(actor, preview.id, "host")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(f.tables.mcpServer![0]).toMatchObject({ enabled: false, revision: 7 });
  });
  it("reimports a removed bundle while preserving a disabled skill that was not removed", async () => {
    const f = await fixture();
    const bundle = (body: string) => [
      {
        path: "SKILL.md",
        bytes: Buffer.from(`---\nname: Fixture\ndescription: Recipe\n---\n${body}`),
      },
    ];
    const [first] = await f.skills.import(actor, bundle("Original."));
    await f.skills.setEnabled(actor, { id: first!.id, kind: "file", enabled: false });
    await expect(f.skills.import(actor, bundle("Disabled is still owned."))).rejects.toThrow(
      "already exists",
    );
    await f.skills.remove(actor, { id: first!.id, kind: "file" });
    expect(await f.skills.list(actor)).toEqual([]);
    const [again] = await f.skills.import(actor, bundle("Corrected."));
    expect(again).toMatchObject({ name: "Fixture", enabled: true });
    expect((await f.skills.get(actor, { id: again!.id, kind: "file" })).content).toContain(
      "Corrected.",
    );
    expect(f.tables.agentSkill).toHaveLength(1);
    const owners = await readdir(path.join(f.deps.dataDir, "skill-bundles"));
    expect(await readdir(path.join(f.deps.dataDir, "skill-bundles", owners[0]!))).toHaveLength(1);
  });
  it("installs skill-only packaged plugins without pairing a host", async () => {
    const f = await fixture();
    const owner = { ...actor, isDeploymentOwner: false };
    const preview = await f.plugins.preview(owner, { name: "review-kit", catalogId: "review-kit" });
    await expect(
      f.plugins.install(owner, preview.id, path.join(f.deps.dataDir, "native"), "host"),
    ).resolves.toMatchObject({ state: "installed" });
    expect(f.tables.agentSkill).toHaveLength(2);
    expect(f.tables.mcpServer).toHaveLength(0);
  });
  it.each([false, true])(
    "requires host pairing only when a packaged plugin has local commands: %s",
    async (local) => {
      const f = await fixture();
      const files = [
        {
          path: "marketplace.json",
          bytes: Buffer.from(
            JSON.stringify({
              name: "fixture-market",
              owner: { name: "Fixture publisher" },
              plugins: [{ name: "fixture", source: "./plugin" }],
            }),
          ),
        },
        {
          path: "plugin/.claude-plugin/plugin.json",
          bytes: Buffer.from(
            JSON.stringify({
              name: "fixture",
              mcpServers: {
                remote: { type: "http", url: "https://example.test/mcp" },
                ...(local ? { local: { command: "node", args: ["server.js"] } } : {}),
              },
            }),
          ),
        },
      ];
      const marketplace = await f.plugins.addMarketplace(actor, { files });
      const preview = await f.plugins.preview(actor, {
        name: "fixture",
        marketplaceId: marketplace.id,
      });
      const install = f.plugins.install(
        actor,
        preview.id,
        path.join(f.deps.dataDir, "native"),
        "host",
      );
      if (local) {
        await expect(install).rejects.toThrow("Connect this computer");
        expect(f.tables.pluginInstall).toEqual([]);
      } else {
        await expect(install).resolves.toMatchObject({ state: "installed" });
        expect(f.tables.mcpServer).toEqual([
          expect.objectContaining({
            placement: "worker",
            transport: "streamable_http",
            enabled: true,
          }),
        ]);
      }
    },
  );
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
      {
        id: "local-sign-in",
        ...actor,
        enabled: true,
        connectionState: "needs-sign-in",
        transport: "host-cli",
      },
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
      json: { needingReconnection: 3 },
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
