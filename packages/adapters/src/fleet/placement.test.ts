import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@ardurbot/adapter-kit";
import { unknownCapacity } from "@ardurbot/contracts/fleet";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import type { FleetCatalog } from "./catalog.js";

const replace = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../computer-lifecycle.js", async (original) => ({
  ...(await original<object>()),
  replaceComputer: replace,
}));
vi.mock("@ardurbot/db", async (original) => ({
  ...(await original<object>()),
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "message" })),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));

import { placeRunComputer } from "./placement.js";

function fixture(approved = false) {
  const bot = {
    id: "bot",
    runtimeKind: "pi",
    archivedAt: null,
    placementConsent: approved,
    moveAutomatically: false,
    pendingPlacement: null,
  };
  const computer = {
    id: "computer",
    homeKey: "home",
    state: "running",
    networkEgress: true,
    kind: "desktop",
    imageProfile: "base",
    connectionId: null,
    maintenanceId: null,
    controlHolder: "none",
    bots: [bot],
  };
  const run = {
    id: "run",
    userId: "owner",
    spaceId: "space",
    botId: "bot",
    threadId: "thread",
    taskId: "task",
    runtimeComputer: null,
    placement: null,
    leaseOwner: "worker",
    leaseFence: 1,
    bot: { ...bot, computer },
  };
  const prisma = {
    run: {
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    space: { findUniqueOrThrow: vi.fn(async () => ({ placement: { mode: "threshold" } })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    computerUpdate: {
      create: vi.fn(async () => ({ id: "move" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    bot: { update: vi.fn(), updateMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  };
  const targets = [
    {
      id: "host",
      name: "This Mac",
      kind: "host",
      connectionId: null,
      state: "connected",
      capacity: { ...unknownCapacity(), memoryFree: 1.2 * 1024 ** 3 },
      bots: [],
    },
    {
      id: "remote",
      name: "Linux computer",
      kind: "ssh",
      connectionId: "remote",
      state: "connected",
      capacity: { ...unknownCapacity(), memoryFree: 16 * 1024 ** 3 },
      bots: [],
    },
  ];
  const supportsNetworkEgress = vi.fn(async () => false);
  const catalog = {
    list: vi.fn(async () => ({ targets, defaultTargetId: "host" })),
    connections: { resolve: vi.fn(async () => ({ supportsNetworkEgress })) },
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    home: {} as AgentHomeStore,
    sandbox: {} as SandboxProvider,
    jobs: {} as JobPublisher,
    events: { append: vi.fn(), notify: vi.fn(async () => undefined) } as unknown as ThreadEvents,
  };
  return {
    prisma,
    run,
    computer,
    deps,
    supportsNetworkEgress,
    catalog: catalog as unknown as FleetCatalog,
  };
}
afterEach(() => vi.clearAllMocks());
it("does not move a network-isolated computer to a target that cannot enforce its policy", async () => {
  const f = fixture(true);
  f.computer.networkEgress = false;
  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(true);
  expect(replace).not.toHaveBeenCalled();
  f.supportsNetworkEgress.mockResolvedValue(true);
  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(true);
  expect(replace).toHaveBeenCalledOnce();
});
it("asks before the first move and leaves the computer untouched", async () => {
  const f = fixture();
  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(
    false,
  );
  expect(replace).not.toHaveBeenCalled();
  expect(f.prisma.bot.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: { pendingPlacement: expect.objectContaining({ runId: "run", targetId: "remote" }) },
    }),
  );
  expect(f.prisma.run.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "waiting_input" }) }),
  );
});
it("uses the checkpoint lifecycle before execution and persists the move reason", async () => {
  const f = fixture(true);
  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(true);
  expect(replace).toHaveBeenCalledWith(
    f.deps,
    "computer",
    "update",
    expect.objectContaining({ operationId: "move", runId: "run" }),
    "none",
    expect.any(Function),
    { imageProfile: "base", connectionId: "remote", placementRunId: "run" },
  );
  expect(f.prisma.run.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: {
        placement: expect.objectContaining({
          status: "moved",
          reason: "Moved to Linux computer: This Mac had 1.2 GB free",
        }),
      },
    }),
  );
  expect(f.prisma.computer.updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({ data: { maintenanceId: null } }),
  );
});
it("never moves an existing run snapshot or a pinned native runtime", async () => {
  const f = fixture(true);
  f.run.runtimeComputer = { id: "saved" } as never;
  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(true);
  f.run.runtimeComputer = null;
  f.run.bot.runtimeKind = "claude-code";
  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(true);
  expect(replace).not.toHaveBeenCalled();
});
it("does not move a shared home while another run is active", async () => {
  const f = fixture(true);
  f.prisma.run.findFirst.mockResolvedValue({ id: "other" } as never);
  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(true);
  expect(replace).not.toHaveBeenCalled();
});

it("never resumes a cancelled run after the workspace has moved", async () => {
  const f = fixture(true);
  f.prisma.run.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(
    false,
  );
  expect(replace).toHaveBeenCalledOnce();
  expect(f.deps.events.notify).not.toHaveBeenCalled();
  expect(f.prisma.run.update).not.toHaveBeenCalled();
  expect(f.prisma.computerUpdate.update).toHaveBeenCalledWith({
    where: { id: "move" },
    data: { status: "completed" },
  });
});
it("keeps a failed move fenced for the executor's normal failure transaction", async () => {
  const f = fixture(true);
  replace.mockRejectedValueOnce(new Error("restore failed"));
  await expect(
    placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal),
  ).rejects.toThrow("restore failed");
  expect(f.prisma.run.updateMany).toHaveBeenLastCalledWith({
    where: {
      id: "run",
      status: "running",
      cancelRequestedAt: null,
      leaseOwner: "worker",
      leaseFence: 1,
    },
    data: { placement: expect.objectContaining({ status: "failed" }) },
  });
  expect(f.prisma.run.update).not.toHaveBeenCalled();
  expect(f.prisma.computer.updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({ data: { maintenanceId: null } }),
  );
});
