import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@ardurbot/adapter-kit";
import { unknownCapacity } from "@ardurbot/contracts/fleet";
import type { Prisma, PrismaClient, ThreadEvents } from "@ardurbot/db";
import { answerRunInput } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import { createRunSecretWriter } from "../run-secret.js";
import { EncryptedSecretStore } from "../secrets.js";
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
    providerRef: "desktop-computer",
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
    computer: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => computer),
    },
    computerUpdate: {
      create: vi.fn(async () => ({ id: "move" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    bot: { findMany: vi.fn(async () => computer.bots), update: vi.fn(), updateMany: vi.fn() },
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
  const targetSandbox = { supportsNetworkEgress } as unknown as SandboxProvider;
  const catalog = {
    list: vi.fn(async () => ({ targets, defaultTargetId: "host" })),
    engineFamily: vi.fn(async () => "desktop"),
    compatibleTargets: vi.fn(async (_family, candidates) => candidates),
    resolveTarget: vi.fn(async () => targetSandbox),
    placementTarget: vi.fn(async () => targetSandbox),
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
    targetSandbox,
    catalog: catalog as unknown as FleetCatalog,
  };
}
afterEach(() => vi.clearAllMocks());

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["bot", "peer"])(
  "commits a placement move during a credential answer for %s without deadlocking",
  async (answerBotId) => {
    const f = fixture(true);
    // The final update clears every bot, including archived owners of the computer.
    f.computer.bots.push({ ...f.computer.bots[0]!, id: "peer", archivedAt: new Date() } as never);
    const firstPlacementLock = barrier();
    const answerBlocked = barrier();
    const resumePlacement = barrier();
    const owners = new Map<string, string>();
    const waiting = new Map<string, string>();
    const released = new Map<string, ReturnType<typeof barrier>>();
    const placementLocks: string[] = [];
    let placementHasLock = false;
    let answerStatus = "waiting_input";
    const saved = vi.fn();
    const placementRunUpdate = vi.fn(async (_input: unknown) => ({ count: 1 }));
    const destination = {
      name: "example_api",
      origin: "https://api.example.test",
      auth: { type: "bearer" },
    };

    // Model exclusive row locks, reentrant acquisition and the two-transaction wait cycle.
    const acquire = async (transaction: string, resource: string) => {
      while (owners.has(resource) && owners.get(resource) !== transaction) {
        const owner = owners.get(resource)!;
        waiting.set(transaction, owner);
        if (waiting.get(owner) === transaction) throw new Error("deadlock detected");
        if (transaction === "answer") answerBlocked.resolve();
        await released.get(owner)!.promise;
        waiting.delete(transaction);
      }
      owners.set(resource, transaction);
    };
    const transaction = async <T>(
      name: string,
      work: (tx: Prisma.TransactionClient) => Promise<T>,
    ) => {
      released.set(name, barrier());
      const tx = {
        ...f.prisma,
        $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
          const query = sql.join("");
          if (query.includes("FROM bots")) {
            if (name === "placement") {
              expect(query).toBe(
                'SELECT id FROM bots WHERE "computerId" =  ORDER BY id FOR UPDATE',
              );
              expect(values).toEqual([f.computer.id]);
              for (const bot of [...f.computer.bots].sort((a, b) => a.id.localeCompare(b.id))) {
                placementLocks.push(`bot:${bot.id}`);
                await acquire(name, `bot:${bot.id}`);
              }
            } else {
              await acquire(name, `bot:${answerBotId}`);
            }
          } else {
            expect(query).toBe("SELECT id FROM threads WHERE id =  FOR UPDATE");
            expect(values).toEqual([f.run.threadId]);
            if (name === "placement") placementLocks.push(`thread:${f.run.threadId}`);
            await acquire(name, `thread:${f.run.threadId}`);
          }
          // Pause after all rows in placement's first statement have been locked.
          if (name === "placement" && !placementHasLock) {
            placementHasLock = true;
            firstPlacementLock.resolve();
            await resumePlacement.promise;
          }
          return [];
        },
        bot: {
          ...f.prisma.bot,
          updateMany: async (input: unknown) => {
            // UPDATE itself takes row locks even when the explicit pre-lock is missing.
            for (const bot of f.computer.bots) await acquire(name, `bot:${bot.id}`);
            return f.prisma.bot.updateMany(input);
          },
        },
        run: {
          ...f.prisma.run,
          findUnique: async () => ({ status: answerStatus, threadId: f.run.threadId }),
          findFirst: async () =>
            answerStatus === "waiting_input" ? { botId: answerBotId, userId: "owner" } : null,
          updateMany: async (input: unknown) => {
            if (name === "placement") return placementRunUpdate(input);
            answerStatus = "queued";
            return { count: 1 };
          },
        },
        message: {
          findFirst: async () => ({
            id: "credential-message",
            blocks: [{ kind: "ask", text: "API key", input: "secret", credential: destination }],
          }),
          update: async () => ({}),
        },
        botSecret: { findFirst: async () => null, count: async () => 0, create: saved },
        externalEffect: { updateMany: async () => ({ count: 1 }) },
        thread: {
          findUniqueOrThrow: async () => ({ groupId: null }),
          update: async () => ({ nextEventSeq: 1 }),
        },
        event: { create: async () => ({ threadId: f.run.threadId, seq: 1 }) },
      };
      try {
        return await work(tx as unknown as Prisma.TransactionClient);
      } finally {
        for (const [resource, owner] of owners) if (owner === name) owners.delete(resource);
        waiting.delete(name);
        released.get(name)!.resolve();
      }
    };
    let transactions = 0;
    f.prisma.$transaction = async (work) => {
      // The preparation transaction finishes before the simulated computer replacement.
      if (++transactions === 1) return work(f.prisma);
      return transaction("placement", work);
    };
    const placement = placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal);
    const moved = expect(placement).resolves.toBe(true);
    await firstPlacementLock.promise;
    const answer = answerRunInput(
      {
        $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          transaction("answer", work),
      } as PrismaClient,
      {
        runId: "credential-run",
        threadId: f.run.threadId,
        spaceId: f.run.spaceId,
        messageId: "credential-message",
        answeredByUserId: "owner",
        answer: "fake-api-key",
      },
      undefined,
      createRunSecretWriter(new EncryptedSecretStore("test-only-encryption-key")),
    );
    // Attach both failure handlers before releasing either side of the forced overlap.
    const answered = expect(answer).resolves.toBe(true);
    await answerBlocked.promise;
    resumePlacement.resolve();
    await Promise.all([moved, answered]);
    expect(placementLocks).toEqual(["bot:bot", "bot:peer", "thread:thread"]);
    expect(saved).toHaveBeenCalledOnce();
    expect(answerStatus).toBe("queued");
    expect(f.prisma.bot.updateMany).toHaveBeenCalledWith({
      where: { computerId: f.computer.id },
      data: { pendingPlacement: expect.anything() },
    });
    expect(placementRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { placement: expect.objectContaining({ status: "moved" }) },
      }),
    );
    expect(f.prisma.computerUpdate.update).toHaveBeenCalledWith({
      where: { id: "move" },
      data: { status: "completed" },
    });
    expect(f.deps.events.notify).toHaveBeenCalledWith(f.run.threadId, 1);
  },
);

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
it("preserves the first consent request when two bots share a computer", async () => {
  const f = fixture();
  const peer = { ...f.computer.bots[0]!, id: "peer" };
  f.computer.bots.push(peer);
  const second = { ...f.run, id: "second", botId: peer.id, threadId: "peer-thread" };
  f.prisma.run.findUniqueOrThrow.mockResolvedValueOnce(f.run).mockResolvedValueOnce(second);
  f.prisma.bot.update.mockImplementation(async ({ where, data }) => {
    Object.assign(f.computer.bots.find((bot) => bot.id === where.id)!, data);
  });

  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(
    false,
  );
  // The first request is now persisted as a placement wait on the shared computer.
  f.prisma.run.findFirst.mockResolvedValue({ id: "run" } as never);
  expect(await placeRunComputer(f.deps, f.catalog, "second", new AbortController().signal)).toBe(
    true,
  );
  expect(f.computer.bots.map((bot) => bot.pendingPlacement)).toEqual([
    expect.objectContaining({ runId: "run" }),
    expect.objectContaining({ runId: "run" }),
  ]);
  expect(f.prisma.run.updateMany).toHaveBeenCalledTimes(1);
  expect(replace).not.toHaveBeenCalled();
  for (const bot of f.computer.bots) bot.placementConsent = true;
  f.prisma.run.findFirst.mockResolvedValue(null);
  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(true);
  expect(replace).toHaveBeenCalledOnce();
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
    f.targetSandbox,
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
it("resolves the computer's engine once and checks every candidate against its family", async () => {
  const f = fixture(true);
  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(true);
  expect(f.catalog.engineFamily).toHaveBeenCalledOnce();
  expect(f.catalog.compatibleTargets).toHaveBeenCalledWith(
    "desktop",
    expect.any(Array),
    expect.any(Object),
  );
  expect(f.catalog.placementTarget).toHaveBeenCalledWith(
    "desktop",
    expect.objectContaining({ id: "remote" }),
    expect.any(Object),
  );
  expect(replace).toHaveBeenCalledOnce();
});
it("never moves a computer whose engine is not configured here", async () => {
  const f = fixture(true);
  vi.mocked(f.catalog.engineFamily).mockRejectedValue(
    new Error("This computer runs on E2B, which is not configured here."),
  );
  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(true);
  expect(f.catalog.list).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  expect(f.prisma.computerUpdate.create).not.toHaveBeenCalled();
});
it("skips an automatic move without a computer update when Settings changed the computer", async () => {
  const f = fixture(true);
  const moved = {
    ...f.computer,
    kind: "docker",
    providerRef: "docker-after-settings",
    connectionId: "engine",
  };
  const list = vi.mocked(f.catalog.list);
  const listed = list.getMockImplementation();
  if (!listed) throw new Error("listing is unavailable");
  list.mockImplementation(async (context) => {
    f.prisma.computer.findUniqueOrThrow.mockResolvedValue(moved as never);
    return listed(context);
  });
  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(true);
  expect(replace).not.toHaveBeenCalled();
  expect(f.catalog.placementTarget).not.toHaveBeenCalled();
  expect(f.prisma.computerUpdate.create).not.toHaveBeenCalled();
  expect(f.prisma.computerUpdate.updateMany).not.toHaveBeenCalled();
  expect(f.prisma.computer.updateMany).not.toHaveBeenCalled();
  expect(f.prisma.run.updateMany).toHaveBeenCalledOnce();
  expect(f.prisma.run.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: { placement: expect.objectContaining({ targetId: "remote", status: "skipped" }) },
    }),
  );
});
it("keeps an automatic local Docker computer when only Kubernetes has room", async () => {
  const f = fixture();
  f.computer.kind = "docker";
  f.computer.providerRef = "docker-computer";
  f.computer.bots[0]!.moveAutomatically = true;
  f.computer.bots[0]!.placementConsent = true;
  f.run.bot.moveAutomatically = true;
  f.run.bot.placementConsent = true;
  f.run.bot.computer = f.computer;
  const docker = {
    id: "docker",
    name: "Docker on this Mac",
    kind: "docker",
    connectionId: null,
    state: "connected",
    capacity: { ...unknownCapacity(), memoryFree: 512 * 1024 ** 2 },
    bots: [{ id: "bot", name: "Bot" }],
  };
  const kubernetes = {
    id: "default",
    name: "Default computer",
    kind: "kubernetes",
    connectionId: null,
    state: "connected",
    capacity: { ...unknownCapacity(), memoryFree: 16 * 1024 ** 3 },
    bots: [],
  };
  vi.mocked(f.catalog.list).mockResolvedValue({
    targets: [docker, kubernetes],
    defaultTargetId: "default",
  } as never);
  vi.mocked(f.catalog.compatibleTargets).mockResolvedValue([docker] as never);

  expect(await placeRunComputer(f.deps, f.catalog, "run", new AbortController().signal)).toBe(true);
  expect(replace).not.toHaveBeenCalled();
  expect(f.computer.state).toBe("running");
  expect(f.prisma.computerUpdate.create).not.toHaveBeenCalled();
  expect(f.prisma.run.updateMany).not.toHaveBeenCalled();
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
