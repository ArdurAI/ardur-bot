import type { SandboxProvider } from "@ardurbot/adapter-kit";
import {
  ComputerConnections,
  ConnectedSandboxProvider,
  DockerSandboxProvider,
  FakeSandboxProvider,
  HostAwareSandbox,
} from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { SPACE_DELETION_CLAIM_TIMEOUT_MS } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

afterEach(() => vi.restoreAllMocks());

function fixture(recovered = false) {
  const actor: Actor = { spaceId: "current", userId: "owner", email: "owner@example.test" };
  const row = {
    homeKey: "shared-home",
    kind: "desktop",
    providerRef: "container-ref" as string | null,
    connectionId: "saved-container",
    imageProfile: "developer",
    networkEgress: false,
  };
  const findMany = vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
    row.providerRef ? [Object.fromEntries(Object.entries(row).filter(([key]) => select[key]))] : [],
  );
  const lifecycle = {
    deletingAt: recovered ? new Date(0) : (null as Date | null),
    deletionClaimId: recovered ? "previous-claim" : (null as string | null),
    deleted: false,
  };
  const remove = vi.fn(async () => {
    lifecycle.deleted = true;
    lifecycle.deletingAt = null;
    lifecycle.deletionClaimId = null;
  });
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(),
    connection: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === "saved-container" &&
        where.spaceId === "empty" &&
        where.connectorId === "computer"
          ? { metadata: { engine: "docker" }, secretId: null }
          : null,
      ),
    },
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
      findUnique: vi.fn(async () => ({ deletingAt: lifecycle.deletingAt })),
      findFirst: vi.fn(async () => ({ id: "empty" })),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.OR) {
          if (lifecycle.deletingAt && lifecycle.deletingAt >= where.OR[1].deletingAt.lt) {
            return { count: 0 };
          }
        } else if (where.deletionClaimId !== lifecycle.deletionClaimId) {
          return { count: 0 };
        }
        Object.assign(lifecycle, data);
        return { count: 1 };
      }),
      delete: remove,
    },
    bot: { count: vi.fn(async () => 0) },
    chatGroup: { count: vi.fn(async () => 0) },
    computer: {
      findMany,
      updateMany: vi.fn(async () => {
        row.providerRef = null;
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (work) => work(prisma)),
  };
  const host = { destroy: vi.fn() } as unknown as SandboxProvider;
  const destroy = vi.spyOn(DockerSandboxProvider.prototype, "destroy").mockResolvedValue(undefined);
  const connections = new ComputerConnections(
    prisma as unknown as PrismaClient,
    { load: vi.fn() },
    { supervisorToken: "test-supervisor-token" },
  );
  const resolve = vi.spyOn(connections, "resolve");
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
  const request = async () => {
    const { response } = await handler.handle(
      new Request("http://example.test/rpc/spaces/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { spaceId: "empty" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { status: response!.status, body: await response!.json() };
  };
  return { prisma, row, lifecycle, findMany, remove, host, destroy, resolve, request };
}

it("deletes an empty space's legacy connected computer through its connection, never the host", async () => {
  const { prisma, lifecycle, findMany, remove, host, destroy, resolve, request } = fixture();
  const { status, body } = await request();
  expect(status, JSON.stringify(body)).toBe(200);
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
    expect.objectContaining({ spaceId: "empty", userId: "owner" }),
  );
  expect(prisma.connection.findFirst).toHaveBeenCalledExactlyOnceWith({
    where: { id: "saved-container", spaceId: "empty", connectorId: "computer" },
  });
  expect(destroy).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      providerRef: "container-ref",
      connectionId: "saved-container",
      imageProfile: "developer",
      networkEgress: false,
    }),
    expect.objectContaining({ spaceId: "empty", userId: "owner", botId: "shared-home" }),
  );
  expect(host.destroy).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledExactlyOnceWith({ where: { id: "empty" } });
  expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]!);
  expect(lifecycle).toEqual({ deleted: true, deletingAt: null, deletionClaimId: null });
});

it.each([false, true])("deletes a dangling connection space (recovered: %s)", async (recovered) => {
  const { prisma, row, lifecycle, remove, host, destroy, request } = fixture(recovered);
  prisma.connection.findFirst.mockResolvedValue(null);
  const warn = vi.spyOn(getLogger(), "warn");
  const { status, body } = await request();
  expect(status, JSON.stringify(body)).toBe(200);
  expect(body).toEqual({ json: { ok: true, activeSpaceId: "current" } });
  expect(prisma.connection.findFirst).toHaveBeenCalledExactlyOnceWith({
    where: { id: "saved-container", spaceId: "empty", connectorId: "computer" },
  });
  expect(prisma.computer.updateMany).toHaveBeenCalledExactlyOnceWith({
    where: {
      spaceId: "empty",
      homeKey: "shared-home",
      providerRef: "container-ref",
      space: { deletionClaimId: expect.any(String) },
    },
    data: { state: "stopped", providerRef: null },
  });
  expect(row.providerRef).toBeNull();
  expect(prisma.computer.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
    remove.mock.invocationCallOrder[0]!,
  );
  expect(remove).toHaveBeenCalledExactlyOnceWith({ where: { id: "empty" } });
  expect(lifecycle).toEqual({ deleted: true, deletingAt: null, deletionClaimId: null });
  expect(warn).toHaveBeenCalledExactlyOnceWith("space computer teardown skipped", {
    reason: "missing_computer_connection",
  });
  expect(host.destroy).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
});

it("keeps an unreachable engine's reference and claim, then retries after the claim expires", async () => {
  const { prisma, row, lifecycle, remove, host, destroy, request } = fixture();
  // The same message must not turn an engine error into a missing-row result.
  destroy.mockRejectedValueOnce(
    new Error("The computer connection is unavailable; choose a connection in Settings."),
  );
  const warn = vi.spyOn(getLogger(), "warn");
  expect((await request()).status).toBe(500);
  expect(row.providerRef).toBe("container-ref");
  expect(lifecycle.deletionClaimId).toEqual(expect.any(String));
  expect(lifecycle.deleted).toBe(false);
  expect(prisma.computer.updateMany).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(prisma.space.updateMany).not.toHaveBeenCalledWith(
    expect.objectContaining({ data: { deletingAt: null, deletionClaimId: null } }),
  );
  expect((await request()).status).toBe(409);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + SPACE_DELETION_CLAIM_TIMEOUT_MS + 1);
  expect((await request()).status).toBe(200);
  expect(destroy).toHaveBeenCalledTimes(2);
  expect(row.providerRef).toBeNull();
  expect(lifecycle).toEqual({ deleted: true, deletingAt: null, deletionClaimId: null });
  expect(host.destroy).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});
