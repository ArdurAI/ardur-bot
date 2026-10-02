import type { SandboxProvider } from "@ardurbot/adapter-kit";
import {
  ComputerConnections,
  ConnectedSandboxProvider,
  FakeSandboxProvider,
  HostAwareSandbox,
} from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

it("deletes an empty space's legacy connected computer through its connection, never the host", async () => {
  const actor: Actor = { spaceId: "current", userId: "owner", email: "owner@example.test" };
  const row = {
    homeKey: "shared-home",
    kind: "desktop",
    providerRef: "container-ref",
    connectionId: "saved-container",
    imageProfile: "developer",
    networkEgress: false,
  };
  const findMany = vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
    row.providerRef ? [Object.fromEntries(Object.entries(row).filter(([key]) => select[key]))] : [],
  );
  const remove = vi.fn();
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(),
    spaceMember: {
      findUnique: vi.fn(async () => ({
        organizationId: "org",
        role: "owner",
        space: { isDefault: false },
      })),
      findMany: vi.fn(async () => [
        { spaceId: "current", createdAt: new Date(0), space: { isDefault: true } },
        { spaceId: "empty", createdAt: new Date(1), space: { isDefault: false } },
      ]),
    },
    space: {
      findUnique: vi.fn(async () => ({ deletingAt: null })),
      findFirst: vi.fn(async () => ({ id: "empty" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      delete: remove,
    },
    bot: { count: vi.fn(async () => 0) },
    chatGroup: { count: vi.fn(async () => 0) },
    computer: {
      findMany,
      updateMany: vi.fn(async () => {
        row.providerRef = "";
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (work) => work(prisma)),
  };
  const host = { destroy: vi.fn() } as unknown as SandboxProvider;
  const container = { destroy: vi.fn() } as unknown as SandboxProvider;
  const connections = new ComputerConnections(
    prisma as unknown as PrismaClient,
    { load: vi.fn() },
    {},
  );
  const resolve = vi.spyOn(connections, "resolve").mockResolvedValue(container);
  const sandbox = new HostAwareSandbox(
    new ConnectedSandboxProvider(new FakeSandboxProvider(), connections),
    host,
    async () => true,
  );
  const handler = new RPCHandler(
    createRouter({
      prisma: prisma as unknown as PrismaClient,
      sandbox,
      env: { sandboxProvider: "fake" },
    } as RouterDeps),
  );
  const { response } = await handler.handle(
    new Request("http://example.test/rpc/spaces/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { spaceId: "empty" } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  const body = await response!.json();
  expect(response!.status, JSON.stringify(body)).toBe(200);
  expect(body).toEqual({ json: { ok: true, activeSpaceId: "current" } });
  expect(findMany).toHaveBeenNthCalledWith(1, {
    where: { spaceId: "empty", providerRef: { not: null } },
    select: expect.objectContaining({
      connectionId: true,
      imageProfile: true,
      networkEgress: true,
    }),
  });
  expect(resolve).toHaveBeenCalledExactlyOnceWith(
    "saved-container",
    expect.objectContaining({ spaceId: "current", userId: "owner" }),
  );
  expect(container.destroy).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      providerRef: "container-ref",
      connectionId: "saved-container",
      imageProfile: "developer",
      networkEgress: false,
    }),
    expect.objectContaining({ spaceId: "current", userId: "owner", botId: "shared-home" }),
  );
  expect(host.destroy).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledExactlyOnceWith({ where: { id: "empty" } });
  expect(vi.mocked(container.destroy).mock.invocationCallOrder[0]).toBeLessThan(
    remove.mock.invocationCallOrder[0]!,
  );
});
