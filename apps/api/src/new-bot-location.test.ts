import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newBotComputerOptions } from "./computer-settings.js";
import type { HostBridge } from "./host-bridge.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const owner: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
beforeEach(() => vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api"));
afterEach(() => vi.unstubAllEnvs());
function fixture({
  connected = true,
  configured = true,
  computerHost = null,
  actor = owner,
  team = null,
  sandboxProvider = "docker",
}: {
  connected?: boolean;
  configured?: boolean;
  computerHost?: "docker" | "this-mac" | null;
  actor?: Actor;
  sandboxProvider?: string;
  team?: { id: string; kind: string; connectionId: string | null } | null;
} = {}) {
  const upsert = vi.fn(async ({ create }) => ({ id: "computer", ...create }));
  const create = vi.fn(async ({ data }) => ({ id: "bot", ...data }));
  const credential = {
    id: "connection",
    userId: "owner",
    provider: "openai-compatible",
    label: "Fixture",
    secretId: "secret",
  };
  const prisma = {
    space: { findUnique: vi.fn(async () => ({ allowedModelDestinations: { mode: "any" } })) },
    userModelCredential: { findFirst: vi.fn(async () => credential) },
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({ credential, modelId: "fixture-model", isDefault: true })),
    },
    secret: { findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "fixture" })) },
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner", computerHost })) },
    connection: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({ metadata: { engine: "docker" } })),
    },
    $queryRaw: vi.fn(async () => []),
    spaceMember: {
      findUnique: vi.fn(async () => ({ organizationId: "org", space: { deletingAt: null } })),
    },
    computer: { upsert, findFirst: vi.fn(async () => team) },
    bot: {
      aggregate: vi.fn(async () => ({ _max: { position: 0 } })),
      findFirst: vi.fn(async () => ({
        id: "bot",
        runtimeExperimental: false,
        computer: { kind: "desktop", spaceId: "space", connectionId: null },
      })),
      create,
      findFirstOrThrow: vi.fn(async () => ({
        id: "bot",
        spaceId: "space",
        name: "Bot",
        title: "",
        description: "",
        instructions: "",
        color: "#000",
        notifyOnFinish: true,
        pinned: false,
        sectionId: null,
        archivedAt: null,
        parentBotId: null,
        memoryScope: null,
        computer: { scope: "dedicated" },
        thread: { id: "thread", unread: false },
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })),
    },
    thread: { create: vi.fn(async () => ({ id: "thread" })) },
    botMcpServer: { findMany: vi.fn(async () => []) },
    browserProfile: { create: vi.fn() },
    memoryDocument: { create: vi.fn() },
    $transaction: vi.fn(async (work) => work(prisma)),
  };
  const hostBridge = {
    status: vi.fn(async () => ({ connected, configured })),
  } as unknown as HostBridge;
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    hostBridge,
    env: { sandboxProvider },
    secrets: {
      load: () =>
        JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "http://localhost:8080/v1",
          reasoning: false,
          thinkingLevel: "off",
        }),
    },
  } as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(procedure: string, input: unknown) {
    const { response } = await handler.handle(
      new Request(`http://localhost/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { status: response!.status, body: await response!.json() };
  }
  return { prisma, deps, hostBridge, upsert, create, call, actor };
}

it.each([
  [{}, "desktop"],
  [{ connected: false }, "docker"],
  [{ configured: false }, "docker"],
  [{ actor: { ...owner, isDeploymentOwner: false, userId: "member" } }, "docker"],
  [{ computerHost: "docker" as const }, "docker"],
  [{ computerHost: "this-mac" as const, connected: false }, "docker"],
])("applies the default in the real create RPC: %j -> %s", async (settings, kind) => {
  const f = fixture(settings);
  const result = await f.call("bots/create", {
    name: "Bot",
    color: "#000",
    computerMode: "dedicated",
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(f.upsert).toHaveBeenCalledOnce();
  expect(f.upsert.mock.calls[0]![0]).toMatchObject({
    create: { kind, scope: "dedicated" },
    update: {},
  });
  expect(f.prisma.computer.findFirst).not.toHaveBeenCalled();
});
it("returns the Team location and sandbox availability through the real options RPC", async () => {
  const f = fixture({
    sandboxProvider: "fake",
    connected: false,
    team: { id: "team", kind: "fake", connectionId: null },
  });
  const result = await f.call("computer/creationOptions", undefined);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.json).toMatchObject({
    sandboxAvailable: true,
    container: null,
    team: { location: "sandbox", connectionId: null },
  });
});
it("publishes the same default and revalidates an explicit host choice after disconnect", async () => {
  const f = fixture();
  expect(await newBotComputerOptions(f.deps, owner, "docker")).toEqual({
    defaultLocation: "host",
    hostAvailable: true,
    sandboxAvailable: true,
    sandboxBoundary: "container",
    container: { connectionId: null },
    team: null,
  });
  vi.mocked(f.hostBridge.status).mockResolvedValue({
    configured: true,
    connected: false,
    roots: [],
    health: null,
  });
  expect(
    (
      await f.call("bots/create", {
        name: "Bot",
        color: "#000",
        computerLocation: "host",
        computerMode: "dedicated",
      })
    ).status,
  ).not.toBe(200);
  expect(f.create).not.toHaveBeenCalled();
  expect(f.upsert).not.toHaveBeenCalled();
});
it.each([
  ["docker", null, "docker"],
  ["desktop", "saved", "docker"],
  ["docker", null, "fake"],
  ["docker", null, "desktop"],
  ["remote-docker", null, "docker"],
  ["none", null, "none"],
  ["unknown", null, "fake"],
] as const)(
  "preserves a supported source Team sandbox or refuses an unusable one: %s / %s",
  async (kind, connectionId, sandboxProvider) => {
    const computer = { id: "team", kind, connectionId, spaceId: "space", scope: "team" };
    const f = fixture({ team: computer, sandboxProvider });
    f.prisma.bot.findFirst.mockResolvedValue({
      name: "Source",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      color: "#000",
      computer,
      runtimeKind: "pi",
    } as never);
    const result = await f.call("bots/duplicate", { botId: "source" });
    const unusable = kind === "none" || kind === "unknown";
    expect(result.status, JSON.stringify(result.body)).toBe(unusable ? 400 : 200);
    if (unusable) {
      expect(JSON.stringify(result.body)).toContain("Change this bot's computer to use it.");
      expect(f.prisma.browserProfile.create).not.toHaveBeenCalled();
    }
    expect(f.create.mock.calls[0]![0].data.computerId).toBe("team");
    expect(f.upsert).not.toHaveBeenCalled();
  },
);
it.each(["host", "conflict"])("maps the duplicate %s refusal", async (refusal) => {
  const f = fixture({
    connected: refusal !== "host",
    team: { id: "team", kind: "desktop", connectionId: null },
  });
  f.prisma.bot.findFirst.mockResolvedValue({
    name: "Source",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    color: "#000",
    computer: {
      kind: refusal === "host" ? "desktop" : "docker",
      connectionId: null,
      scope: "team",
      spaceId: "space",
    },
    runtimeKind: "pi",
  } as never);
  const result = await f.call("bots/duplicate", { botId: "source" });
  expect(result.status).toBe(400);
  expect(JSON.stringify(result.body)).toContain(
    refusal === "host" ? "new-bot-host-unavailable" : "new-bot-team-location-conflict",
  );
  expect(f.create).not.toHaveBeenCalled();
});
it.each([
  ["docker", null, "docker"],
  ["desktop", "saved", "docker"],
  ["docker", null, "fake"],
  ["docker", null, "desktop"],
  ["remote-docker", null, "docker"],
  ["none", null, "none"],
  ["unknown", null, "fake"],
] as const)(
  "automatic first/quick/starter bots join the saved Team sandbox: %s / %s",
  async (kind, connectionId, sandboxProvider) => {
    const f = fixture({ team: { id: "team", kind, connectionId }, sandboxProvider });
    const result = await f.call("bots/create", { name: "Starter", color: "#000" });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(f.create.mock.calls[0]![0].data.computerId).toBe("team");
    expect(f.upsert).not.toHaveBeenCalled();
  },
);
it("automatic creation cannot join an unavailable host Team computer", async () => {
  const f = fixture({
    actor: { ...owner, userId: "member", isDeploymentOwner: false },
    team: { id: "team", kind: "desktop", connectionId: null },
  });
  const result = await f.call("bots/create", { name: "Starter", color: "#000" });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(f.upsert.mock.calls[0]![0].create).toMatchObject({ kind: "docker", scope: "dedicated" });
});
it("does not repurpose a saved Team container to satisfy an explicit host choice", async () => {
  const f = fixture({ team: { id: "team", kind: "docker", connectionId: null } });
  expect(
    (
      await f.call("bots/create", {
        name: "Bot",
        color: "#000",
        computerMode: "team",
        computerLocation: "host",
      })
    ).status,
  ).not.toBe(200);
  expect(f.upsert).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});
it.each([
  ["desktop", null, "host", "docker"],
  ["docker", null, "sandbox", "fake"],
  ["docker", null, "sandbox", "desktop"],
  ["remote-docker", null, "sandbox", "docker"],
  ["none", null, "sandbox", "none"],
  ["unknown", null, "sandbox", "fake"],
  ["desktop", "saved", "sandbox", "docker"],
] as const)(
  "publishes the Team execution location: %s / %s",
  async (kind, connectionId, location, sandboxProvider) => {
    const f = fixture({ team: { id: "team", kind, connectionId }, sandboxProvider });
    f.prisma.connection.findMany.mockResolvedValue([
      {
        id: "saved",
        displayName: "Saved engine",
        status: "connected",
        metadata: { engine: "docker" },
      },
    ] as never);
    expect((await newBotComputerOptions(f.deps, owner, sandboxProvider)).team).toMatchObject({
      location,
      connectionId,
    });
  },
);
it.each(["fake", "e2b", "daytona", "box"])(
  "offers and creates a team bot on the deployment's %s sandbox",
  async (sandboxProvider) => {
    const f = fixture({ sandboxProvider, connected: false, configured: false });
    expect(await newBotComputerOptions(f.deps, owner, sandboxProvider)).toMatchObject({
      defaultLocation: "sandbox",
      sandboxAvailable: true,
      sandboxBoundary: sandboxProvider === "fake" ? "test" : "hosted",
      container: null,
    });
    const result = await f.call("bots/create", {
      name: "Bot",
      color: "#000",
      computerMode: "team",
      computerLocation: "sandbox",
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(f.upsert.mock.calls[0]![0].create).toMatchObject({
      kind: sandboxProvider,
      scope: "team",
    });
  },
);
it("uses the host when a host-only deployment has a sandbox override but no sandbox", async () => {
  const f = fixture({ sandboxProvider: "desktop", computerHost: "docker" });
  expect(await newBotComputerOptions(f.deps, owner, "desktop")).toMatchObject({
    defaultLocation: "host",
    sandboxAvailable: false,
  });
  const result = await f.call("bots/create", {
    name: "Bot",
    color: "#000",
    computerMode: "dedicated",
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(f.upsert.mock.calls[0]![0].create.kind).toBe("desktop");
});
it("automatic creation uses a saved container when only sandbox is available", async () => {
  const f = fixture({
    sandboxProvider: "desktop",
    actor: { ...owner, userId: "member", isDeploymentOwner: false },
  });
  f.prisma.connection.findMany.mockResolvedValue([
    { id: "saved", metadata: { engine: "docker" }, displayName: "Saved", status: "connected" },
  ] as never);
  const result = await f.call("bots/create", { name: "Starter", color: "#000" });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(f.upsert.mock.calls[0]![0].create).toMatchObject({
    kind: "remote-docker",
    connectionId: "saved",
  });
});
it("honors an explicit sandbox choice even with a connected host", async () => {
  const f = fixture();
  expect(
    (
      await f.call("bots/create", {
        name: "Bot",
        color: "#000",
        computerMode: "dedicated",
        computerLocation: "sandbox",
        isolatedComputer: { connectionId: null },
      })
    ).status,
  ).toBe(200);
  expect(f.upsert.mock.calls[0]![0].create.kind).toBe("docker");
});
it.each([true, false])(
  "preserves explicitly local desktop creation only for its owner: %s",
  async (isDeploymentOwner) => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
    const f = fixture({
      sandboxProvider: "desktop",
      connected: false,
      configured: false,
      actor: { ...owner, isDeploymentOwner },
    });
    expect(await newBotComputerOptions(f.deps, f.actor, "desktop")).toMatchObject({
      hostAvailable: isDeploymentOwner,
      defaultLocation: isDeploymentOwner ? "host" : "sandbox",
    });
    const result = await f.call("bots/create", {
      name: "Bot",
      color: "#000",
      computerMode: "dedicated",
    });
    expect(result.status).toBe(isDeploymentOwner ? 200 : 400);
    if (isDeploymentOwner) expect(f.upsert.mock.calls[0]![0].create.kind).toBe("desktop");
    else expect(f.create).not.toHaveBeenCalled();
  },
);
it("joins a connectionless legacy desktop Team row as host without rewriting it", async () => {
  const f = fixture({ team: { id: "team", kind: "desktop", connectionId: null } });
  const result = await f.call("bots/create", {
    name: "Bot",
    color: "#000",
    computerMode: "team",
    computerLocation: "host",
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(f.create.mock.calls[0]![0].data.computerId).toBe("team");
  expect(f.upsert).not.toHaveBeenCalled();
});
it("does not mistake a connection-backed legacy desktop Team row for host", async () => {
  const f = fixture({ team: { id: "team", kind: "desktop", connectionId: "saved" } });
  const result = await f.call("bots/create", {
    name: "Bot",
    color: "#000",
    computerMode: "team",
    computerLocation: "host",
  });
  expect(result.status).toBe(400);
  expect(f.create).not.toHaveBeenCalled();
});
it("fails closed when a legacy Team row's saved engine disappeared", async () => {
  const f = fixture({ team: { id: "team", kind: "desktop", connectionId: "saved" } });
  f.prisma.connection.findFirst.mockResolvedValue(null as never);
  const result = await f.call("bots/create", { name: "Bot", color: "#000", computerMode: "team" });
  expect(result.status).toBe(400);
  expect(f.create).not.toHaveBeenCalled();
});
it("onboarding creates the first bot without a provider and a second bot joins its Team row", async () => {
  const f = fixture({ sandboxProvider: "none", connected: false, configured: false });
  const input = { name: "Starter", color: "#000" };
  const first = await f.call("bots/create", input);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(f.upsert.mock.calls[0]![0]).toMatchObject({
    create: { kind: "none", scope: "team" },
    update: {},
  });
  f.prisma.computer.findFirst.mockResolvedValue({
    id: "computer",
    kind: "none",
    connectionId: null,
  });
  const options = await f.call("computer/creationOptions", undefined);
  expect(options.body.json.team).toEqual({ location: "sandbox", connectionId: null });
  const second = await f.call("bots/create", input);
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  expect(f.create).toHaveBeenCalledTimes(2);
  expect(f.create.mock.calls[1]![0].data.computerId).toBe("computer");
  expect(f.upsert).toHaveBeenCalledOnce();
});
it.each(["fake", "desktop"])(
  "the form joins a connectionless Team docker row on %s without moving it",
  async (sandboxProvider) => {
    const f = fixture({
      sandboxProvider,
      team: { id: "team", kind: "docker", connectionId: null },
    });
    f.prisma.connection.findMany.mockResolvedValue([
      { id: "saved", metadata: { engine: "docker" }, displayName: "Saved", status: "connected" },
    ] as never);
    const options = await f.call("computer/creationOptions", undefined);
    expect(options.body.json).toMatchObject({
      sandboxAvailable: true,
      team: { location: "sandbox", connectionId: null },
    });
    const result = await f.call("bots/create", {
      name: "Bot",
      color: "#000",
      computerMode: "team",
      computerLocation: "sandbox",
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(f.create.mock.calls[0]![0].data.computerId).toBe("team");
    expect(f.upsert).not.toHaveBeenCalled();
  },
);
it("refuses a different saved Team connection with the existing conflict code", async () => {
  const f = fixture({ team: { id: "team", kind: "desktop", connectionId: "first" } });
  const result = await f.call("bots/create", {
    name: "Bot",
    color: "#000",
    computerMode: "team",
    computerLocation: "sandbox",
    isolatedComputer: { connectionId: "second" },
  });
  expect(result.status).toBe(400);
  expect(JSON.stringify(result.body)).toContain("new-bot-team-location-conflict");
  expect(f.create).not.toHaveBeenCalled();
  expect(f.upsert).not.toHaveBeenCalled();
});
it("a non-owner duplicate cannot reach the host Team computer", async () => {
  const computer = {
    id: "team",
    kind: "desktop",
    connectionId: null,
    scope: "team",
    spaceId: "space",
  };
  const f = fixture({
    team: computer,
    actor: { ...owner, userId: "member", isDeploymentOwner: false },
  });
  f.prisma.bot.findFirst.mockResolvedValue({
    name: "Source",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    color: "#000",
    computer,
    runtimeKind: "pi",
  } as never);
  const result = await f.call("bots/duplicate", { botId: "source" });
  expect(result.status).toBe(400);
  expect(JSON.stringify(result.body)).toContain("new-bot-host-unavailable");
  expect(f.create).not.toHaveBeenCalled();
  expect(f.upsert).not.toHaveBeenCalled();
});
it("joins a legacy Team row on the identical saved sandbox without rewriting it", async () => {
  const f = fixture({ team: { id: "team", kind: "desktop", connectionId: "saved" } });
  const result = await f.call("bots/create", {
    name: "Bot",
    color: "#000",
    computerMode: "team",
    computerLocation: "sandbox",
    isolatedComputer: { connectionId: "saved" },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(f.create.mock.calls[0]![0].data.computerId).toBe("team");
  expect(f.upsert).not.toHaveBeenCalled();
});
