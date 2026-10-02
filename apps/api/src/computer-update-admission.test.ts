import type * as Adapters from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { beforeEach, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const { getBot, queue, replace, acquire, release } = vi.hoisted(() => ({
  getBot: vi.fn(),
  queue: vi.fn(),
  replace: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@ardurbot/db", () => ({
  Prisma: { sql: vi.fn() },
  DeviceRequestError: class extends Error {},
  createRepos: vi.fn(() => ({ getBot })),
  createGroupRepos: vi.fn(() => ({})),
}));
vi.mock("@ardurbot/adapters", async (original) => ({
  ...(await original<typeof Adapters>()),
  queueComputerUpdate: queue,
  replaceComputer: replace,
  acquireComputerExecutionLease: acquire,
  releaseComputerExecutionLease: release,
}));

beforeEach(() => vi.clearAllMocks());
const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
const rows = [
  { kind: "desktop", connectionId: null, host: true },
  { kind: "desktop", connectionId: "docker", host: false },
  { kind: "desktop", connectionId: "podman", host: false },
  { kind: "remote-docker", connectionId: "docker", host: false },
];

it.each(rows)("update admission follows $kind / $connectionId", async (row) => {
  const computer = {
    ...row,
    id: "computer",
    scope: "team",
    state: "running",
    controlHolder: "none",
    controlLeaseId: null,
    homeRevision: "saved",
  };
  getBot.mockResolvedValue({ id: "bot", name: "Builder", computer });
  const result = {
    action: "update",
    id: "update",
    computerId: "computer",
    botId: "bot",
    name: "Builder",
    mode: "team",
    status: "queued",
    stage: "preparing",
    canReleaseReservation: false,
  };
  queue.mockResolvedValue(result);
  const prisma = {
    computer: { findUniqueOrThrow: vi.fn(async () => computer) },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({ prisma, env: { sandboxProvider: "fake" } } as unknown as RouterDeps),
  );
  const { response } = await handler.handle(
    new Request("http://fixture.test/rpc/computer/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: "bot" } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  if (row.host) {
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      json: { message: "Computer update is not available on this device" },
    });
    expect(queue).not.toHaveBeenCalled();
  } else {
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ json: result });
    expect(queue).toHaveBeenCalledWith(expect.anything(), "computer", "bot");
  }
});

it.each(rows)("reset preserves existing admission for $kind / $connectionId", async (row) => {
  const computer = {
    ...row,
    id: "computer",
    scope: "team",
    state: "running",
    controlHolder: "none",
    controlLeaseId: null,
    homeRevision: "saved",
  };
  getBot.mockResolvedValue({ id: "bot", name: "Builder", computer });
  acquire.mockResolvedValue(null);
  replace.mockResolvedValue({});
  const prisma = {
    computer: { findUniqueOrThrow: vi.fn(async () => computer) },
    computerExecutionLease: { findUnique: vi.fn(async () => null) },
    hostRegistration: { findUnique: vi.fn(async () => ({ platform: "linux" })) },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({
      prisma,
      jobs: { enqueue: vi.fn() },
      env: { sandboxProvider: "fake" },
    } as unknown as RouterDeps),
  );
  const { response } = await handler.handle(
    new Request("http://fixture.test/rpc/computer/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: "bot" } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  expect(response.status).toBe(200);
  expect((await response.json()).json).toMatchObject({
    connectionId: row.connectionId,
    canUpdate: !row.host,
  });
  expect(replace).toHaveBeenCalledWith(
    expect.anything(),
    "computer",
    "reset",
    expect.objectContaining({ botId: "bot" }),
  );
  expect(release).toHaveBeenCalledOnce();
});
