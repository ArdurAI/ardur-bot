import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
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
        async ({ where, data }: { where: { computerHost?: null }; data: typeof settings }) => {
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
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
  };
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
    pair: () =>
      new HostBridge(prisma as unknown as PrismaClient, "fixture-encryption-material").pair(
        owner.userId,
      ),
  };
}

function desktopStack() {
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
