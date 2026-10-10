import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

// This read-only route uses the supplied Prisma mock, never a generated database client.
vi.mock("@ardurbot/db", () => ({
  Prisma: { sql: vi.fn() },
  DeviceRequestError: class extends Error {},
  createRepos: vi.fn(() => ({})),
  createGroupRepos: vi.fn(() => ({})),
}));

it("deduplicates shared computers within the owner and space, even with an invalid stored runtime kind", async () => {
  const actor: Actor = {
    userId: "owner",
    spaceId: "space",
    email: "owner@example.test",
    isDeploymentOwner: true,
  };
  const computer = {
    kind: "desktop",
    state: "stopped",
    scope: "dedicated",
    controlHolder: "none",
    homeRevision: "saved",
  };
  const bots = [
    {
      id: "legacy-bot",
      name: "Legacy",
      runtimeKind: "legacy-runtime",
      computer: { ...computer, id: "legacy-computer" },
    },
    {
      id: "native-bot",
      name: "Native",
      runtimeKind: "hermes",
      computer: { ...computer, id: "native-computer" },
    },
  ];
  bots.push({ ...bots[1]!, id: "sharing-bot", name: "Sharing" });
  const findMany = vi.fn(async () => bots);
  const prisma = {
    bot: { findMany },
    hostRegistration: { findUnique: vi.fn(async () => ({ platform: "linux" })) },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({ prisma, env: { sandboxProvider: "fake" } } as unknown as RouterDeps),
  );
  const { response } = await handler.handle(
    new Request("http://fixture.test/rpc/computer/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: null }),
    }),
    { prefix: "/rpc", context: { actor } },
  );

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.json).toEqual([
    {
      botId: "legacy-bot",
      name: "Legacy",
      status: expect.objectContaining({
        computerId: "legacy-computer",
        kind: "desktop",
        hostLabel: "This computer",
      }),
    },
    {
      botId: "native-bot",
      name: "Native",
      runtimeKind: "hermes",
      status: expect.objectContaining({ computerId: "native-computer", kind: "desktop" }),
    },
  ]);
  expect(body.json[0]).not.toHaveProperty("runtimeKind");
  expect(findMany).toHaveBeenCalledExactlyOnceWith({
    where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    include: { computer: true },
  });
  expect(bots[0]?.runtimeKind).toBe("legacy-runtime");
});
