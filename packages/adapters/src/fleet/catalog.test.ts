import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  JobPublisher,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import { choosePlacement, unknownCapacity } from "@ardurbot/contracts/fleet";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import { performComputerUpdate } from "../computer-update.js";
import { DesktopSandboxProvider } from "../desktop-sandbox.js";
import { DockerSandboxProvider } from "../docker-sandbox.js";
import { FakeSandboxProvider } from "../fake-sandbox.js";
import { LocalAgentHomeStore } from "../home.js";
import { createRunSandbox, HostAwareSandbox } from "../host-aware-sandbox.js";
import { FleetCatalog } from "./catalog.js";
import { placeRunComputer } from "./placement.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("uses the configured desktop fallback for null bindings and can place work back on it", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  vi.stubEnv("SANDBOX_PROVIDER", "desktop");
  vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockResolvedValue({
    name: "docker",
    rootless: false,
    version: "test",
    os: "linux",
    capacity: unknownCapacity(),
  });
  const fallback = createRunSandbox("desktop", {});
  const capacity = { ...unknownCapacity(), source: "host" as const, memoryFree: 16 * 1024 ** 3 };
  vi.spyOn(fallback, "capacity").mockResolvedValue(capacity);
  const prisma = {
    connection: { findMany: async () => [] },
    bot: {
      findMany: async () => [
        { id: "bot", name: "Bot", computer: { kind: "desktop", connectionId: null } },
      ],
    },
    space: { findUniqueOrThrow: async () => ({ placement: { mode: "free-memory" } }) },
    deploymentSettings: { findUnique: async () => ({ computerHost: null }) },
  };
  const context: AdapterContext = {
    userId: "owner",
    spaceId: "space",
    operationId: "list",
    traceId: "list",
    signal: new AbortController().signal,
  };
  const catalog = new FleetCatalog(
    prisma as unknown as PrismaClient,
    { load: () => "" },
    {},
    fallback,
  );
  const fleet = await catalog.list(context);
  expect(fleet.defaultTargetId).toBe("host");
  expect(fleet.targets.find((target) => target.id === "host")).toMatchObject({
    capacity,
    bots: [{ id: "bot", name: "Bot" }],
  });
  const remote = {
    id: "remote",
    name: "Remote",
    kind: "ssh" as const,
    connectionId: "remote",
    state: "connected" as const,
    capacity: { ...capacity, memoryFree: 1024 ** 3 },
    bots: [],
  };
  const candidates = [...fleet.targets, remote].filter(
    (target) => target.connectionId !== null || target.id === fleet.defaultTargetId,
  );
  expect(choosePlacement(fleet.placement, "remote", candidates)).toMatchObject({
    targetId: "host",
    connectionId: null,
  });
  await catalog.testDefault(context);
  const tested = await catalog.list(context);
  expect(tested.targets.find((target) => target.id === "default")).toMatchObject({
    kind: "docker",
    version: "test",
    os: "linux",
  });
});

it("lists a local Docker computer separately when Kubernetes is the default and places from that row", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const dockerCapacity = {
    ...unknownCapacity(),
    source: "docker" as const,
    memoryFree: 512 * 1024 ** 2,
  };
  const kubernetesCapacity = {
    ...unknownCapacity(),
    source: "kubernetes-metrics" as const,
    memoryFree: 32 * 1024 ** 3,
  };
  vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockResolvedValue({
    name: "docker",
    rootless: false,
    version: "test",
    os: "linux",
    capacity: dockerCapacity,
  });
  const bot = {
    id: "bot",
    name: "Bot",
    runtimeKind: "pi",
    archivedAt: null,
    placementConsent: false,
    moveAutomatically: false,
    pendingPlacement: null,
  };
  const computer = {
    id: "computer",
    homeKey: "home",
    providerRef: "ref",
    state: "running",
    networkEgress: true,
    kind: "docker",
    imageProfile: "base",
    connectionId: null,
    maintenanceId: null,
    controlHolder: "none",
    bots: [bot],
  };
  const prisma = {
    connection: { findMany: async () => [] },
    bot: {
      findMany: vi.fn(async () => [{ ...bot, computer }]),
      update: vi.fn(async () => ({})),
    },
    space: {
      findUniqueOrThrow: async () => ({ placement: { mode: "threshold", minimumFreeGb: 4 } }),
    },
    deploymentSettings: { findUnique: async () => ({ computerHost: null }) },
    run: {
      findUniqueOrThrow: async () => ({
        id: "run",
        userId: "owner",
        spaceId: "space",
        botId: "bot",
        threadId: "thread",
        runtimeComputer: null,
        placement: null,
        leaseOwner: "worker",
        leaseFence: 1,
        bot: { ...bot, computer },
      }),
      findUnique: async () => ({
        status: "running",
        startedAt: new Date(),
        originDeviceGrantId: null,
        remoteRootTaskId: null,
        delegationId: null,
      }),
      findFirst: async () => null,
      updateMany: async () => ({ count: 1 }),
    },
    thread: { update: async () => ({ nextEventSeq: 2 }) },
    event: { create: async () => ({ seq: 1 }) },
    $queryRaw: async () => [],
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  };
  const context: AdapterContext = {
    userId: "owner",
    spaceId: "space",
    operationId: "list",
    traceId: "list",
    signal: new AbortController().signal,
  };
  const fallback = {
    describe: () => ({ id: "kubernetes" }),
    capacity: async () => kubernetesCapacity,
  } as unknown as SandboxProvider;
  const catalog = new FleetCatalog(
    prisma as unknown as PrismaClient,
    { load: () => "" },
    {},
    fallback,
  );
  const fleet = await catalog.list(context);
  const docker = fleet.targets.find(
    (target) => target.connectionId === null && target.kind === "docker",
  );
  const kubernetes = fleet.targets.find((target) => target.kind === "kubernetes");
  expect(fleet.defaultTargetId).toBe("default");
  expect(docker?.id).toBeTruthy();
  expect(docker?.id).not.toBe(kubernetes?.id);
  expect(docker).toMatchObject({
    capacity: expect.objectContaining({ memoryFree: dockerCapacity.memoryFree }),
    bots: [{ id: "bot", name: "Bot" }],
  });
  expect(kubernetes?.bots).toEqual([]);
  await expect(catalog.resolveComputer(computer, context)).resolves.toBeInstanceOf(
    DockerSandboxProvider,
  );
  await expect(catalog.resolveTarget(kubernetes!, context)).resolves.toBe(fallback);
  await expect(
    catalog.compatibleTargets(computer, [docker!, kubernetes!], context),
  ).resolves.toEqual([docker]);
  const settingsRouting = await catalog.resolveReplacementRouting(
    computer,
    { connectionId: null },
    context,
  );
  expect(settingsRouting.source).toBeInstanceOf(DockerSandboxProvider);
  expect(settingsRouting.target).toBe(settingsRouting.source);
  await expect(
    catalog.resolveReplacementRouting(
      computer,
      { connectionId: null, targetId: kubernetes!.id },
      context,
      fleet,
    ),
  ).rejects.toThrow("Computer replacement target is unavailable");
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    home: {} as AgentHomeStore,
    sandbox: {} as SandboxProvider,
    jobs: {} as JobPublisher,
    events: { append: vi.fn(), notify: vi.fn(async () => undefined) } as unknown as ThreadEvents,
  };
  expect(await placeRunComputer(deps, catalog, "run", new AbortController().signal)).toBe(true);
  expect(prisma.bot.update).not.toHaveBeenCalled();
});

it("does not automatically move a Docker computer onto This Mac through the host-aware sandbox", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const dockerCapacity = {
    ...unknownCapacity(),
    source: "docker" as const,
    memoryFree: 512 * 1024 ** 2,
  };
  const hostCapacity = {
    ...unknownCapacity(),
    source: "host" as const,
    memoryFree: 32 * 1024 ** 3,
  };
  vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockResolvedValue({
    name: "docker",
    rootless: false,
    version: "test",
    os: "linux",
    capacity: dockerCapacity,
  });
  vi.spyOn(DockerSandboxProvider.prototype, "exportWorkspace").mockImplementation(
    async function* () {
      yield { path: "notes/keep.txt", content: new TextEncoder().encode("saved") };
    },
  );
  vi.spyOn(DockerSandboxProvider.prototype, "releaseScreen").mockResolvedValue(undefined);
  const destroy = vi.spyOn(DockerSandboxProvider.prototype, "destroy").mockResolvedValue(undefined);
  vi.spyOn(DesktopSandboxProvider.prototype, "capacity").mockResolvedValue(hostCapacity);
  vi.spyOn(DesktopSandboxProvider.prototype, "provision").mockResolvedValue({
    id: "desktop-computer",
    botId: "home",
    kind: "desktop",
    providerRef: "desktop-ref",
    fresh: true,
  });
  const bot = {
    id: "bot",
    name: "Bot",
    runtimeKind: "pi",
    archivedAt: null,
    placementConsent: true,
    moveAutomatically: true,
    pendingPlacement: null,
  };
  const computer = {
    id: "computer",
    homeKey: "home",
    providerRef: "docker-computer",
    state: "running",
    networkEgress: true,
    kind: "docker",
    imageProfile: "base",
    connectionId: null,
    maintenanceId: null,
    controlHolder: "none",
    bots: [bot],
  };
  const prisma = {
    connection: { findMany: async () => [] },
    bot: { findMany: async () => [{ ...bot, computer }], update: vi.fn(), updateMany: vi.fn() },
    space: {
      findUniqueOrThrow: async () => ({
        placement: { mode: "threshold", minimumFreeGb: 4, preferredTargetId: "host" },
      }),
    },
    deploymentSettings: { findUnique: async () => ({ computerHost: "this-mac" }) },
    run: {
      findUniqueOrThrow: async () => ({
        id: "run",
        userId: "owner",
        spaceId: "space",
        botId: "bot",
        threadId: "thread",
        runtimeComputer: null,
        placement: null,
        leaseOwner: "worker",
        leaseFence: 1,
        bot: { ...bot, computer },
      }),
      findFirst: async () => null,
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    computerUpdate: {
      create: vi.fn(async () => ({ id: "move" })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $queryRaw: async () => [],
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  };
  const context: AdapterContext = {
    userId: "owner",
    spaceId: "space",
    operationId: "place",
    traceId: "place",
    signal: new AbortController().signal,
  };
  const fallback = createRunSandbox("docker", { prisma: prisma as unknown as PrismaClient });
  const catalog = new FleetCatalog(
    prisma as unknown as PrismaClient,
    { load: () => "" },
    {},
    fallback,
  );
  const fleet = await catalog.list(context);
  const host = fleet.targets.find((target) => target.id === "host");
  expect(fallback).toBeInstanceOf(HostAwareSandbox);
  expect(fallback.describe().id).toBe("docker");
  expect(fleet.defaultTargetId).toBe("host");
  expect(host?.capacity.memoryFree).toBeGreaterThan(dockerCapacity.memoryFree);
  const outcome = await placeRunComputer(
    {
      prisma: prisma as unknown as PrismaClient,
      home: {} as AgentHomeStore,
      sandbox: fallback,
      jobs: {} as JobPublisher,
      events: { notify: vi.fn(async () => undefined) } as unknown as ThreadEvents,
    },
    catalog,
    "run",
    new AbortController().signal,
  ).then(
    (value) => value,
    (error: unknown) => error,
  );
  expect(prisma.computerUpdate.create).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  expect(outcome).toBe(true);
  await expect(
    catalog.resolveReplacementRouting(
      computer,
      { connectionId: null, targetId: "host" },
      context,
      fleet,
    ),
  ).rejects.toThrow("Computer replacement target is unavailable");
});

it("completes a Settings connection change from Docker to Kubernetes and refuses that placement", async () => {
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-settings-home-"));
  const kubernetes = new FakeSandboxProvider();
  const described = kubernetes.describe();
  vi.spyOn(kubernetes, "describe").mockReturnValue({ ...described, id: "kubernetes" });
  vi.spyOn(DockerSandboxProvider.prototype, "exportWorkspace").mockImplementation(
    async function* () {
      yield { path: "notes/keep.txt", content: new TextEncoder().encode("saved") };
    },
  );
  vi.spyOn(DockerSandboxProvider.prototype, "releaseScreen").mockResolvedValue(undefined);
  const destroy = vi.spyOn(DockerSandboxProvider.prototype, "destroy").mockResolvedValue(undefined);
  const computer = {
    id: "computer-1",
    homeKey: "bot-1",
    providerRef: "docker-computer",
    state: "running",
    networkEgress: true,
    kind: "docker",
    imageProfile: "base" as const,
    connectionId: null as string | null,
    maintenanceId: "update-1",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    controlRunId: null,
    scope: "dedicated",
    spaceId: "space",
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    homeRevision: "1",
  };
  const configuration = {
    imageProfile: "base" as const,
    connectionId: "k8s",
    confirmed: true as const,
  };
  const row = {
    id: "update-1",
    computerId: computer.id,
    botId: "bot-1",
    action: "update",
    status: "queued",
    stage: "preparing",
    updatedAt: new Date(0),
    configuration,
    computer,
  };
  const prisma = {
    connection: { findMany: async () => [] },
    bot: { findMany: async () => [], findFirst: vi.fn(async () => ({ userId: "owner" })) },
    space: { findUniqueOrThrow: async () => ({ placement: {} }) },
    deploymentSettings: { findUnique: async () => ({ computerHost: null }) },
    computer: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValueOnce(computer)
        .mockResolvedValue({
          ...computer,
          state: "stopped",
          providerRef: null,
          connectionId: "k8s",
        }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    computerUpdate: {
      findUniqueOrThrow: vi.fn(async () => row),
      updateMany: vi.fn(async ({ where, data }) => {
        const status = where.status;
        const matches =
          !status ||
          status === row.status ||
          (typeof status === "object" && status.in.includes(row.status));
        if (!matches) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    computerExecutionLease: { findFirst: vi.fn(async () => null) },
    run: { findFirst: vi.fn(async () => null) },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  };
  const context: AdapterContext = {
    userId: "owner",
    spaceId: "space",
    operationId: "update-1",
    traceId: "update-1",
    signal: new AbortController().signal,
  };
  const fallback = {
    describe: () => ({ id: "kubernetes" }),
    capacity: async () => unknownCapacity(),
  } as unknown as SandboxProvider;
  const catalog = new FleetCatalog(
    prisma as unknown as PrismaClient,
    { load: () => "" },
    {},
    fallback,
  );
  vi.spyOn(catalog.connections, "resolve").mockResolvedValue(kubernetes);
  const fleet = {
    targets: [
      {
        id: "k8s",
        name: "Cluster",
        kind: "kubernetes" as const,
        connectionId: "k8s",
        state: "connected" as const,
        capacity: unknownCapacity(),
        bots: [],
      },
    ],
    bots: [],
    placement: { mode: "manual" as const, preferredTargetId: "host", minimumFreeGb: 4 },
    defaultTargetId: "default",
  };
  try {
    await expect(
      catalog.resolveReplacementRouting(
        computer,
        { connectionId: "k8s", targetId: "k8s" },
        context,
        fleet,
      ),
    ).rejects.toThrow("Computer replacement target is unavailable");
    expect(destroy).not.toHaveBeenCalled();
    const routing = await catalog.resolveReplacementRouting(computer, configuration, context);
    expect(routing.source).toBeInstanceOf(DockerSandboxProvider);
    expect(routing.source.describe().id).toBe("docker");
    expect(routing.target.describe().id).toBe("kubernetes");
    await performComputerUpdate(
      {
        prisma: prisma as unknown as PrismaClient,
        sandbox: fallback,
        home: new LocalAgentHomeStore(homeRoot),
        jobs: { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
        events: {} as ThreadEvents,
        fleet: catalog,
      },
      row.id,
    );
    expect(row.status).toBe("completed");
    expect(destroy).toHaveBeenCalledOnce();
    const saved = [...kubernetes.boxes.values()]
      .flatMap((box) => [...box.files.entries()])
      .find(([file]) => file === "notes/keep.txt");
    expect(saved && new TextDecoder().decode(saved[1].content)).toBe("saved");
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});
