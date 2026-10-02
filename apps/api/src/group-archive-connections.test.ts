import type { JobPublisher, SandboxProvider } from "@ardurbot/adapter-kit";
import {
  ComputerConnections,
  ConnectedSandboxProvider,
  cancelComputerRunWorkArgv,
  FakeSandboxProvider,
  HostAwareSandbox,
} from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

it("archives a group and cancels work on its legacy connected computer, never the host", async () => {
  const actor: Actor = { spaceId: "space", userId: "owner", email: "owner@example.test" };
  const row = {
    id: "computer",
    homeKey: "shared-home",
    kind: "desktop",
    providerRef: "container-ref",
    connectionId: "saved-container",
    imageProfile: "developer",
    networkEgress: false,
    executionBotId: "bot",
    executionRunId: "run",
  };
  const findMany = vi.fn(async ({ select }: { select: Record<string, boolean> }) => [
    Object.fromEntries(Object.entries(row).filter(([key]) => select[key])),
  ]);
  const prisma = {
    $queryRaw: vi.fn(async () => [{ id: "group" }]),
    chatGroup: {
      findFirst: vi.fn(async () => ({ thread: { id: "thread" } })),
      update: vi.fn(),
    },
    run: {
      findMany: vi.fn(async () => [
        { id: "run", taskId: "task", delegationId: null, threadId: "thread", spaceId: "space" },
      ]),
      updateMany: vi.fn(),
    },
    attempt: { updateMany: vi.fn() },
    task: { updateMany: vi.fn() },
    event: { deleteMany: vi.fn() },
    computer: { findMany, updateMany: vi.fn() },
    computerExecutionLease: {
      findMany: vi.fn(async () => [{ computerId: "computer", runId: "run", fence: 7 }]),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (work) => work(prisma)),
  };
  const host = { execute: vi.fn(), releaseScreen: vi.fn() } as unknown as SandboxProvider;
  const container = {
    execute: vi.fn(async function* () {
      yield { type: "exit", code: 0 } as const;
    }),
    releaseScreen: vi.fn(),
  } as unknown as SandboxProvider;
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
  const cancel = vi.fn().mockResolvedValue(undefined);
  const handler = new RPCHandler(
    createRouter({
      prisma: prisma as unknown as PrismaClient,
      sandbox,
      jobs: { cancel } as unknown as JobPublisher,
      env: { sandboxProvider: "fake" },
    } as RouterDeps),
  );
  const { response } = await handler.handle(
    new Request("http://example.test/rpc/groups/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { groupId: "group" } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  const body = await response!.json();
  expect(response!.status, JSON.stringify(body)).toBe(200);
  expect(body).toEqual({ json: { ok: true } });
  expect(findMany).toHaveBeenCalledExactlyOnceWith({
    where: { executionRunId: { in: ["run"] } },
    select: expect.objectContaining({
      connectionId: true,
      imageProfile: true,
      networkEgress: true,
    }),
  });
  expect(resolve).toHaveBeenCalledWith(
    "saved-container",
    expect.objectContaining({ spaceId: "space", userId: "owner" }),
  );
  const ref = expect.objectContaining({
    providerRef: "container-ref",
    connectionId: "saved-container",
    imageProfile: "developer",
    networkEgress: false,
  });
  const context = expect.objectContaining({
    spaceId: "space",
    userId: "owner",
    botId: "bot",
    runId: "run",
    screenLeaseId: "run:7",
    cancelRunWork: true,
  });
  expect(container.execute).toHaveBeenCalledExactlyOnceWith(
    ref,
    { argv: cancelComputerRunWorkArgv("computer", "run"), timeoutMs: 15_000 },
    context,
  );
  expect(container.releaseScreen).toHaveBeenCalledExactlyOnceWith(ref, context);
  expect(host.execute).not.toHaveBeenCalled();
  expect(host.releaseScreen).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  expect(prisma.chatGroup.update).toHaveBeenCalledExactlyOnceWith({
    where: { id: "group" },
    data: { archivedAt: expect.any(Date), pinned: false },
  });
});
