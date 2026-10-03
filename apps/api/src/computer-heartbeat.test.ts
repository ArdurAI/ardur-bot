import type { SandboxProvider } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const { getBot } = vi.hoisted(() => ({ getBot: vi.fn() }));
vi.mock("@ardurbot/db", () => ({
  Prisma: { sql: vi.fn() },
  DeviceRequestError: class extends Error {},
  createRepos: vi.fn(() => ({ getBot })),
  createGroupRepos: vi.fn(() => ({})),
}));

it("heartbeats preserve a legacy desktop row's connection and workspace policy", async () => {
  const actor: Actor = {
    userId: "owner",
    spaceId: "space",
    email: "owner@example.test",
    isDeploymentOwner: true,
  };
  getBot.mockResolvedValue({
    id: "bot",
    computer: {
      id: "computer",
      homeKey: "home",
      providerRef: "container-ref",
      kind: "desktop",
      connectionId: "saved-container",
      spaceId: "space",
      userId: "owner",
      state: "running",
      imageProfile: "developer",
      networkEgress: false,
    },
  });
  const keepAlive = vi.fn();
  const handler = new RPCHandler(
    createRouter({
      prisma: {
        computer: {
          updateMany: vi.fn(),
          findUnique: vi.fn(async () => ({ sleepFailureReason: null })),
        },
      } as unknown as PrismaClient,
      sandbox: { keepAlive } as unknown as SandboxProvider,
      jobs: { enqueue: vi.fn() },
      env: { sandboxProvider: "fake" },
    } as unknown as RouterDeps),
  );
  const { response } = await handler.handle(
    new Request("http://fixture.test/rpc/computer/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: "bot" } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ json: { ok: true } });
  expect(keepAlive).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      connectionId: "saved-container",
      imageProfile: "developer",
      networkEgress: false,
    }),
  );
});
