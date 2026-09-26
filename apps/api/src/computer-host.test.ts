import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const owner: Actor = {
  spaceId: "space-1",
  userId: "owner-1",
  email: "owner@ardurbot.test",
  isDeploymentOwner: true,
};

afterEach(() => vi.unstubAllEnvs());

async function hostChoice(sandboxProvider: string, computerHost: string | null) {
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
    deploymentSettings: { findUnique: vi.fn(async () => ({ computerHost })) },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({
      prisma,
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
  const me = await read("me");
  expect(await read("deployment/get")).toEqual(me);
  return me;
}

it("never asks where bots run in the desktop app's local mode", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  expect(await hostChoice("desktop", null)).toEqual({
    canChooseHostComputer: false,
    computerHost: "this-mac",
  });
});

it.each([
  [null, "this-mac"],
  ["this-mac", "this-mac"],
  ["docker", "docker"],
])(
  "never asks on the desktop app's own Compose stack, where no choice means this computer (%s)",
  async (stored, computerHost) => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    vi.stubEnv("ARDURBOT_DESKTOP_STACK", "1");
    expect(await hostChoice("docker", stored)).toEqual({
      canChooseHostComputer: false,
      computerHost,
    });
  },
);

it.each(["api", ""])(
  "still lets a server's owner choose, with Docker the default (host bridge %j)",
  async (bridge) => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", bridge);
    vi.stubEnv("ARDURBOT_DESKTOP_STACK", "");
    expect(await hostChoice("docker", null)).toEqual({
      canChooseHostComputer: true,
      computerHost: null,
    });
    expect(await hostChoice("docker", "this-mac")).toEqual({
      canChooseHostComputer: true,
      computerHost: "this-mac",
    });
  },
);
