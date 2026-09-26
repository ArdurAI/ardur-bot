import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { createRepos } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, expect, it, vi } from "vitest";
import { HostBridge } from "./host-bridge.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const owner: Actor = {
  spaceId: "space-1",
  userId: "owner-1",
  email: "owner@ardurbot.test",
  isDeploymentOwner: true,
};

afterEach(() => vi.unstubAllEnvs());

/** One deployment: its saved host choice, its host registration, and the API that reads them. */
function deployment(sandboxProvider: string, computerHost: string | null) {
  const settings = { id: "default", ownerUserId: owner.userId, computerHost };
  let registration: unknown = null;
  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({
        email: owner.email,
        name: "Owner",
        avatarStyle: "robot",
      })),
    },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ...settings })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { computerHost?: string | null };
          data: Partial<typeof settings>;
        }) => {
          if ("computerHost" in where && settings.computerHost !== where.computerHost)
            return { count: 0 };
          Object.assign(settings, data);
          return { count: 1 };
        },
      ),
    },
    hostRegistration: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        if (registration) throw new Error("Already paired");
        registration = data;
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        if (!registration || (registration as { userId: string }).userId !== where.userId)
          return { count: 0 };
        registration = null;
        return { count: 1 };
      }),
    },
    // What creating a bot writes; the computer row records the kind it starts on.
    $queryRaw: vi.fn(async () => []),
    spaceMember: {
      findUnique: vi.fn(async () => ({ organizationId: "org", space: { deletingAt: null } })),
    },
    computer: {
      upsert: vi.fn(async ({ create }: { create: { kind: string } }) => ({
        id: "computer",
        ...create,
      })),
    },
    bot: {
      aggregate: vi.fn(async () => ({ _max: { position: 0 } })),
      create: vi.fn(async () => ({ id: "bot" })),
      findFirstOrThrow: vi.fn(async () => ({
        id: "bot",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "New",
        title: "",
        description: "",
        instructions: "",
        color: "#000",
        notifyOnFinish: false,
        pinned: false,
        position: 1,
        sectionId: null,
        archivedAt: null,
        parentBotId: null,
        memoryScope: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        thread: { id: "thread", unread: false, messages: [] },
        runs: [],
        computer: null,
      })),
    },
    thread: { create: vi.fn(async () => ({ id: "thread" })) },
    browserProfile: { create: vi.fn(async () => ({})) },
    memoryDocument: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
  };
  const bridge = new HostBridge(prisma as unknown as PrismaClient, "fixture-encryption-material");
  const handler = new RPCHandler(
    createRouter({
      prisma: prisma as unknown as PrismaClient,
      env: {
        agentRuntime: "scripted",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        sandboxProvider,
      },
      dataDir: "/tmp/ardurbot-computer-host-test",
    } as unknown as RouterDeps),
  );
  const read = async (path: string) => {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor: owner } },
    );
    expect(response?.status).toBe(200);
    const { json } = (await response!.json()) as {
      json: { canChooseHostComputer: boolean; computerHost: string | null };
    };
    return { canChooseHostComputer: json.canChooseHostComputer, computerHost: json.computerHost };
  };
  return {
    /** What `me` reports, checked against `deployment/get`. */
    async hostChoice() {
      const me = await read("me");
      expect(await read("deployment/get")).toEqual(me);
      return me;
    },
    /** Set up on the desktop: the owner pairs this computer's host service. */
    pair: () => bridge.pair(owner.userId),
    /** Disconnect this computer in Settings. */
    disconnect: () => bridge.disconnect(owner.userId),
    /** Disconnect called by a user who holds no registration of their own. */
    disconnectAs: (userId: string) => bridge.disconnect(userId),
    /** The kind a new bot's computer starts on. */
    async newBotKind() {
      prisma.computer.upsert.mockClear();
      await createRepos(prisma as unknown as PrismaClient).createBot(owner, {
        name: "New",
        title: "",
        description: "",
        instructions: "",
        color: "#000",
        notifyOnFinish: false,
      });
      return prisma.computer.upsert.mock.calls[0]?.[0].create.kind;
    },
  };
}

function desktopStack() {
  vi.stubEnv("SANDBOX_PROVIDER", "docker");
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
  vi.stubEnv("ARDURBOT_DESKTOP_STACK", "1");
}

it("never asks where bots run in the desktop app's local mode", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  expect(await deployment("desktop", null).hostChoice()).toEqual({
    canChooseHostComputer: false,
    computerHost: "this-mac",
  });
});

it("on the desktop app's own Compose stack never asks, and chooses this computer when Set up pairs it", async () => {
  desktopStack();
  const stack = deployment("docker", null);
  expect(await stack.hostChoice()).toEqual({ canChooseHostComputer: false, computerHost: null });
  await stack.pair();
  expect(await stack.hostChoice()).toEqual({
    canChooseHostComputer: false,
    computerHost: "this-mac",
  });
});

it("on the desktop app's own Compose stack keeps an earlier choice of Docker after Set up", async () => {
  desktopStack();
  const stack = deployment("docker", "docker");
  await stack.pair();
  expect(await stack.hostChoice()).toEqual({
    canChooseHostComputer: false,
    computerHost: "docker",
  });
});

it.each(["api", ""])(
  "still lets a server's owner choose, with Docker the default even after pairing (host bridge %j)",
  async (bridge) => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", bridge);
    vi.stubEnv("ARDURBOT_DESKTOP_STACK", "");
    const server = deployment("docker", null);
    expect(await server.hostChoice()).toEqual({
      canChooseHostComputer: true,
      computerHost: null,
    });
    await server.pair();
    expect(await server.hostChoice()).toEqual({
      canChooseHostComputer: true,
      computerHost: null,
    });
    expect(await deployment("docker", "this-mac").hostChoice()).toEqual({
      canChooseHostComputer: true,
      computerHost: "this-mac",
    });
  },
);

it("on the desktop app's own Compose stack returns new bots to Docker when this computer is disconnected", async () => {
  desktopStack();
  const stack = deployment("docker", null);
  expect(await stack.newBotKind()).toBe("docker");
  await stack.pair();
  expect(await stack.newBotKind()).toBe("desktop");
  await stack.disconnect();
  expect(await stack.hostChoice()).toEqual({ canChooseHostComputer: false, computerHost: null });
  expect(await stack.newBotKind()).toBe("docker");
  // Set up picks this computer again.
  await stack.pair();
  expect(await stack.newBotKind()).toBe("desktop");
});

it("on the desktop app's own Compose stack, a Disconnect that finds no registration of its own leaves the choice unchanged", async () => {
  desktopStack();
  // computerHost is already "this-mac" without ever pairing here, so the delete removes nothing.
  const stack = deployment("docker", "this-mac");
  await stack.disconnectAs(owner.userId);
  expect(await stack.hostChoice()).toEqual({
    canChooseHostComputer: false,
    computerHost: "this-mac",
  });
});

it.each([
  ["the desktop app's own Compose stack keeps an earlier Docker choice", "1", "docker", "docker"],
  ["a server keeps the owner's choice of the host", "", "this-mac", "this-mac"],
])("on disconnect, %s", async (_case, stack, stored, kept) => {
  vi.stubEnv("SANDBOX_PROVIDER", "docker");
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
  vi.stubEnv("ARDURBOT_DESKTOP_STACK", stack);
  const deploymentWithChoice = deployment("docker", stored);
  await deploymentWithChoice.pair();
  await deploymentWithChoice.disconnect();
  expect((await deploymentWithChoice.hostChoice()).computerHost).toBe(kept);
});
