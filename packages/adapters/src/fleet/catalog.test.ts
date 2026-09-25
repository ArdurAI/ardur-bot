import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  ProcessEvent,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { choosePlacement, unknownCapacity } from "@ardurbot/contracts/fleet";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerConnections } from "../computer-connections.js";
import { provisionComputer, replaceComputer } from "../computer-lifecycle.js";
import { performComputerUpdate } from "../computer-update.js";
import { DesktopSandboxProvider } from "../desktop-sandbox.js";
import { DockerSandboxProvider } from "../docker-sandbox.js";
import { FakeSandboxProvider } from "../fake-sandbox.js";
import { LocalAgentHomeStore } from "../home.js";
import { createRunSandbox, HostAwareSandbox } from "../host-aware-sandbox.js";
import { KubernetesSandboxProvider } from "../kubernetes-sandbox.js";
import { FakeKubernetesApi } from "../kubernetes-test-api.js";
import { FleetCatalog } from "./catalog.js";
import { placeRunComputer } from "./placement.js";

function storedComputer(overrides: Record<string, unknown> = {}) {
  const row = {
    id: "computer",
    homeKey: "home",
    providerRef: "docker-computer" as string | null,
    state: "running",
    networkEgress: true,
    kind: "docker",
    imageProfile: "base",
    connectionId: null as string | null,
    maintenanceId: null as string | null,
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    controlRunId: null,
    scope: "dedicated",
    spaceId: "space",
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    homeRevision: "1",
    ...overrides,
  };
  return {
    row,
    findUniqueOrThrow: vi.fn(async () => ({ ...row })),
    updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
}

function localDocker(ref: Partial<ComputerRef> = {}) {
  return {
    provision: vi.spyOn(DockerSandboxProvider.prototype, "provision").mockResolvedValue({
      id: "docker-computer",
      botId: "home",
      kind: "docker",
      providerRef: "docker-computer",
      connectionId: null,
      fresh: false,
      ...ref,
    }),
    prepare: vi.spyOn(DockerSandboxProvider.prototype, "prepare").mockResolvedValue(undefined),
    execute: vi
      .spyOn(DockerSandboxProvider.prototype, "execute")
      .mockImplementation(async function* (): AsyncGenerator<ProcessEvent> {
        yield { type: "exit", code: 0 };
      }),
    writeFile: vi.spyOn(DockerSandboxProvider.prototype, "writeFile").mockResolvedValue(undefined),
    releaseScreen: vi
      .spyOn(DockerSandboxProvider.prototype, "releaseScreen")
      .mockResolvedValue(undefined),
    stop: vi.spyOn(DockerSandboxProvider.prototype, "stop").mockResolvedValue(undefined),
    destroy: vi.spyOn(DockerSandboxProvider.prototype, "destroy").mockResolvedValue(undefined),
  };
}

function kubernetesDefault(prisma: unknown) {
  const api = new FakeKubernetesApi();
  const sandbox = createRunSandbox("kubernetes", {
    kubernetes: {
      api,
      settings: ComputerConnectionSettingsSchema.parse({
        engine: "kubernetes",
        context: "cluster",
      }),
    },
    prisma: prisma as PrismaClient,
    secrets: { load: () => "" },
  });
  return { api, sandbox };
}

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

const movingBot = {
  id: "bot",
  name: "Bot",
  runtimeKind: "pi",
  archivedAt: null,
  placementConsent: true,
  moveAutomatically: true,
  pendingPlacement: null,
};

function runRow(computer: Record<string, unknown>, placement: unknown = null) {
  return {
    id: "run",
    userId: "owner",
    spaceId: "space",
    botId: "bot",
    threadId: "thread",
    runtimeComputer: null,
    placement,
    leaseOwner: "worker",
    leaseFence: 1,
    bot: { ...movingBot, computer: { ...computer, bots: [movingBot] } },
  };
}

const runContext: AdapterContext = {
  userId: "owner",
  spaceId: "space",
  botId: "bot",
  runId: "run",
  operationId: "run",
  traceId: "run",
  signal: new AbortController().signal,
};

it.each([
  ["placement finds no engine of the same kind", null],
  ["the owner declined the move", { status: "declined" }],
])(
  "runs a local Docker computer on Docker under a Kubernetes default when %s",
  async (_reason, placement) => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
    const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-local-docker-"));
    vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockResolvedValue({
      name: "docker",
      rootless: false,
      version: "test",
      os: "linux",
      capacity: { ...unknownCapacity(), source: "docker", memoryFree: 512 * 1024 ** 2 },
    });
    const docker = localDocker();
    const computer = storedComputer({ scope: "team" });
    const prisma = {
      connection: { findMany: async () => [] },
      bot: { findMany: async () => [{ ...movingBot, computer: computer.row }] },
      space: { findUniqueOrThrow: async () => ({ placement: { mode: "free-memory" } }) },
      deploymentSettings: { findUnique: async () => ({ computerHost: null }) },
      run: { findUniqueOrThrow: async () => runRow(computer.row, placement) },
      computer,
    };
    const { api, sandbox } = kubernetesDefault(prisma);
    vi.spyOn(sandbox, "capacity").mockResolvedValue({
      ...unknownCapacity(),
      source: "kubernetes-metrics",
      memoryFree: 32 * 1024 ** 3,
    });
    const deps = {
      prisma: prisma as unknown as PrismaClient,
      home: new LocalAgentHomeStore(homeRoot),
      sandbox,
      jobs: {} as JobPublisher,
      events: {} as ThreadEvents,
    };
    try {
      const catalog = new FleetCatalog(deps.prisma, { load: () => "" }, {}, sandbox);
      expect(await placeRunComputer(deps, catalog, "run", runContext.signal)).toBe(true);
      const ref = await provisionComputer(deps, "computer", runContext, "bot");
      const events: ProcessEvent[] = [];
      for await (const event of sandbox.execute(ref, { argv: ["true"] }, runContext))
        events.push(event);
      await sandbox.writeFile(ref, { path: "notes.txt", content: new Uint8Array() }, runContext);
      await sandbox.releaseScreen?.(ref, runContext);
      await sandbox.stop(ref, runContext);
      expect(events).toEqual([{ type: "exit", code: 0 }]);
      expect(docker.provision).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: "docker-computer", providerKind: "docker" }),
        runContext,
      );
      for (const call of [
        docker.prepare,
        docker.execute,
        docker.writeFile,
        docker.releaseScreen,
        docker.stop,
      ])
        expect(call).toHaveBeenCalled();
      expect(api.requests).toEqual([]);
      expect(computer.row).toMatchObject({
        state: "running",
        kind: "docker",
        providerRef: "docker-computer",
      });
    } finally {
      api.dispose();
      await rm(homeRoot, { recursive: true, force: true });
    }
  },
);

it("resets a local Docker computer under a Kubernetes default through Docker", async () => {
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-local-reset-"));
  const docker = localDocker({ id: "docker-new", providerRef: "docker-new", fresh: true });
  const computer = storedComputer();
  const prisma = { computer, run: { findFirst: async () => null } };
  const { api, sandbox } = kubernetesDefault(prisma);
  const context = { ...runContext, runId: undefined, operationId: "reset", traceId: "reset" };
  try {
    await replaceComputer(
      {
        prisma: prisma as unknown as PrismaClient,
        home: new LocalAgentHomeStore(homeRoot),
        sandbox,
        jobs: {} as JobPublisher,
        events: {} as ThreadEvents,
      },
      "computer",
      "reset",
      context,
    );
    expect(docker.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "docker-computer", kind: "docker" }),
      context,
    );
    expect(docker.provision).toHaveBeenCalledOnce();
    expect(api.requests).toEqual([]);
    expect(computer.row).toMatchObject({
      state: "running",
      kind: "docker",
      providerRef: "docker-new",
    });
  } finally {
    api.dispose();
    await rm(homeRoot, { recursive: true, force: true });
  }
});

function savedPodman(onDestroy: () => void = () => undefined) {
  return {
    describe: () => ({ id: "docker" }),
    capacity: async () => ({
      ...unknownCapacity(),
      source: "docker" as const,
      memoryFree: 512 * 1024 ** 2,
    }),
    async *exportWorkspace() {
      yield { path: "notes/keep.txt", content: new TextEncoder().encode("saved") };
    },
    releaseScreen: async () => undefined,
    destroy: vi.fn(async () => onDestroy()),
  } as unknown as SandboxProvider & { destroy: ReturnType<typeof vi.fn> };
}

it("provisions an automatic move where it was checked when This Mac turns on mid-move", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-frozen-move-"));
  let computerHost: string | null = null;
  vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockResolvedValue({
    name: "docker",
    rootless: false,
    version: "test",
    os: "linux",
    capacity: { ...unknownCapacity(), source: "docker", memoryFree: 32 * 1024 ** 3 },
  });
  const docker = localDocker({ id: "docker-new", providerRef: "docker-new", fresh: true });
  const hostProvision = vi
    .spyOn(DesktopSandboxProvider.prototype, "provision")
    .mockRejectedValue(new Error("This Mac must not receive the move"));
  const podman = savedPodman(() => {
    computerHost = "this-mac";
  });
  vi.spyOn(ComputerConnections.prototype, "resolve").mockResolvedValue(podman);
  const computer = storedComputer({ connectionId: "engine", providerRef: "podman-computer" });
  const prisma = {
    connection: {
      findMany: async () => [
        {
          id: "engine",
          displayName: "Podman",
          status: "connected",
          metadata: { engine: "podman", socket: "/tmp/podman.sock" },
        },
      ],
    },
    bot: {
      findMany: async () => [{ ...movingBot, computer: computer.row }],
      updateMany: async () => ({ count: 1 }),
    },
    space: {
      findUniqueOrThrow: async () => ({ placement: { mode: "threshold", minimumFreeGb: 4 } }),
    },
    deploymentSettings: { findUnique: async () => ({ computerHost }) },
    run: {
      findUniqueOrThrow: async () => runRow(computer.row),
      findFirst: async ({ where }: { where: { id?: unknown } }) =>
        where.id === "run"
          ? { id: "run", runtimeComputer: null, placement: { status: "moving" } }
          : null,
      findUnique: async () => ({
        status: "running",
        startedAt: new Date(),
        originDeviceGrantId: null,
        remoteRootTaskId: null,
        delegationId: null,
      }),
      updateMany: async () => ({ count: 1 }),
    },
    computer,
    computerUpdate: {
      create: async () => ({ id: "move" }),
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
    },
    thread: { update: async () => ({ nextEventSeq: 2, nextMessageSeq: 2 }) },
    message: { create: async () => ({ id: "message" }) },
    event: { create: async () => ({ seq: 1, type: "thread.message.created" }) },
    $queryRaw: async () => [],
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  };
  const sandbox = createRunSandbox("docker", {
    prisma: prisma as unknown as PrismaClient,
    secrets: { load: () => "" },
  });
  const catalog = new FleetCatalog(
    prisma as unknown as PrismaClient,
    { load: () => "" },
    {},
    sandbox,
  );
  try {
    const moved = await placeRunComputer(
      {
        prisma: prisma as unknown as PrismaClient,
        home: new LocalAgentHomeStore(homeRoot),
        sandbox,
        jobs: {} as JobPublisher,
        events: { notify: vi.fn(async () => undefined) } as unknown as ThreadEvents,
      },
      catalog,
      "run",
      runContext.signal,
    );
    expect(podman.destroy).toHaveBeenCalledOnce();
    expect(computerHost).toBe("this-mac");
    expect(hostProvision).not.toHaveBeenCalled();
    expect(docker.provision).toHaveBeenCalledOnce();
    expect(moved).toBe(true);
    expect(computer.row).toMatchObject({
      state: "running",
      kind: "docker",
      connectionId: null,
      providerRef: "docker-new",
    });
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("keeps a failed Settings move to the deployment default pointed at that engine", async () => {
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-failed-settings-move-"));
  const podman = savedPodman();
  vi.spyOn(ComputerConnections.prototype, "resolve").mockResolvedValue(podman);
  const computer = storedComputer({
    connectionId: "engine",
    providerRef: "podman-computer",
    maintenanceId: "update-1",
  });
  const prisma = { computer, run: { findFirst: async () => null } };
  const { api, sandbox } = kubernetesDefault(prisma);
  vi.spyOn(KubernetesSandboxProvider.prototype, "provision").mockRejectedValue(
    new Error("cluster is full"),
  );
  const catalog = new FleetCatalog(
    prisma as unknown as PrismaClient,
    { load: () => "" },
    {},
    sandbox,
  );
  const context = { ...runContext, runId: undefined, operationId: "update-1" };
  try {
    const routing = await catalog.resolveReplacementRouting(
      computer.row,
      { connectionId: null },
      context,
    );
    await expect(
      replaceComputer(
        {
          prisma: prisma as unknown as PrismaClient,
          home: new LocalAgentHomeStore(homeRoot),
          sandbox,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer",
        "update",
        context,
        "none",
        undefined,
        { imageProfile: "base", connectionId: null },
        routing,
      ),
    ).rejects.toThrow("cluster is full");
    expect(podman.destroy).toHaveBeenCalledOnce();
    expect(computer.row).toMatchObject({ state: "error", connectionId: null, kind: "kubernetes" });
    await expect(catalog.resolveComputer(computer.row, context)).resolves.toBe(routing.target);
  } finally {
    api.dispose();
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("moves a connectionless Docker computer onto This Mac through Settings", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-this-mac-move-"));
  vi.spyOn(DockerSandboxProvider.prototype, "releaseScreen").mockResolvedValue(undefined);
  const destroy = vi.spyOn(DockerSandboxProvider.prototype, "destroy").mockResolvedValue(undefined);
  const dockerProvision = vi.spyOn(DockerSandboxProvider.prototype, "provision");
  vi.spyOn(DesktopSandboxProvider.prototype, "provision").mockResolvedValue({
    id: "desktop-computer",
    botId: "home",
    kind: "desktop",
    providerRef: "host:home",
    fresh: true,
  });
  vi.spyOn(DesktopSandboxProvider.prototype, "prepare").mockResolvedValue(undefined);
  const computer = storedComputer({ maintenanceId: "update-1", state: "running" });
  const configuration = {
    imageProfile: "base" as const,
    connectionId: null,
    confirmed: true as const,
    thisMac: true as const,
  };
  const update = {
    id: "update-1",
    computerId: computer.row.id,
    botId: "bot",
    action: "update",
    status: "queued",
    stage: "preparing",
    updatedAt: new Date(0),
    configuration,
    computer: computer.row,
  };
  const prisma = {
    connection: { findMany: async () => [] },
    bot: { findFirst: async () => ({ userId: "owner" }) },
    deploymentSettings: { findUnique: async () => ({ computerHost: "this-mac" }) },
    computer,
    computerUpdate: {
      findUniqueOrThrow: async () => update,
      updateMany: vi.fn(async ({ where, data }: { where: { status?: unknown }; data: object }) => {
        const status = where.status;
        const matches =
          !status ||
          status === update.status ||
          (typeof status === "object" &&
            status !== null &&
            "in" in status &&
            (status as { in: string[] }).in.includes(update.status));
        if (!matches) return { count: 0 };
        Object.assign(update, data);
        return { count: 1 };
      }),
    },
    run: { findFirst: async () => null },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  };
  const sandbox = createRunSandbox("docker", {
    prisma: prisma as unknown as PrismaClient,
    secrets: { load: () => "" },
  });
  const catalog = new FleetCatalog(
    prisma as unknown as PrismaClient,
    { load: () => "" },
    {},
    sandbox,
  );
  const context = { ...runContext, runId: undefined, operationId: "update-1" };
  try {
    const routing = await catalog.resolveReplacementRouting(computer.row, configuration, context);
    expect(routing.source.describe().id).toBe("docker");
    expect(routing.target.describe().id).toBe("desktop");
    expect(routing.source).not.toBe(routing.target);
    await performComputerUpdate(
      {
        prisma: prisma as unknown as PrismaClient,
        sandbox,
        home: new LocalAgentHomeStore(homeRoot),
        jobs: { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
        events: {} as ThreadEvents,
        fleet: catalog,
      },
      update.id,
    );
    expect(update.status).toBe("completed");
    expect(destroy).toHaveBeenCalledOnce();
    expect(dockerProvision).not.toHaveBeenCalled();
    expect(computer.row).toMatchObject({
      state: "running",
      kind: "desktop",
      connectionId: null,
      providerRef: "host:home",
    });
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("keeps a started Kubernetes computer on Kubernetes and leaves the row when that provider is missing", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-k8s-kind-"));
  const kubernetes = {
    describe: () => ({ id: "kubernetes" }),
    provision: vi.fn(
      async (request: { botId: string; providerRef?: string; providerKind?: string }) => ({
        id: "pod",
        botId: request.botId,
        kind: "kubernetes" as const,
        providerRef: request.providerRef ?? "pod-1",
        fresh: false,
      }),
    ),
    prepare: vi.fn(async () => undefined),
    execute: vi.fn(async function* (): AsyncGenerator<ProcessEvent> {
      yield { type: "exit", code: 0 };
    }),
  };
  const docker = vi.spyOn(DockerSandboxProvider.prototype, "provision");
  const desktop = vi.spyOn(DesktopSandboxProvider.prototype, "provision");
  const missing = storedComputer({
    kind: "kubernetes",
    providerRef: "pod-1",
    state: "running",
    connectionId: null,
  });
  const present = storedComputer({
    id: "computer-k8s",
    kind: "kubernetes",
    providerRef: "pod-1",
    state: "running",
    connectionId: null,
  });
  const settings = { findUnique: async () => ({ computerHost: "this-mac" }) };
  try {
    const unavailable = createRunSandbox("docker", {
      prisma: { deploymentSettings: settings, computer: missing } as unknown as PrismaClient,
      secrets: { load: () => "" },
    });
    await expect(
      provisionComputer(
        {
          prisma: { computer: missing } as unknown as PrismaClient,
          home: new LocalAgentHomeStore(homeRoot),
          sandbox: unavailable,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer",
        runContext,
        "bot",
      ),
    ).rejects.toThrow("No Kubernetes provider is registered.");
    expect(missing.updateMany).not.toHaveBeenCalled();
    expect(missing.row).toMatchObject({
      state: "running",
      kind: "kubernetes",
      providerRef: "pod-1",
    });
    expect(docker).not.toHaveBeenCalled();
    expect(desktop).not.toHaveBeenCalled();

    const sandbox = createRunSandbox("docker", {
      prisma: { deploymentSettings: settings, computer: present } as unknown as PrismaClient,
      secrets: { load: () => "" },
      providers: { kubernetes: () => kubernetes as never },
    });
    const ref = await provisionComputer(
      {
        prisma: { computer: present } as unknown as PrismaClient,
        home: new LocalAgentHomeStore(homeRoot),
        sandbox,
        jobs: {} as JobPublisher,
        events: {} as ThreadEvents,
      },
      "computer-k8s",
      runContext,
      "bot",
    );
    expect(kubernetes.provision).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "pod-1", providerKind: "kubernetes" }),
      runContext,
    );
    const events: ProcessEvent[] = [];
    for await (const event of sandbox.execute(ref, { argv: ["true"] }, runContext))
      events.push(event);
    expect(events).toEqual([{ type: "exit", code: 0 }]);
    expect(kubernetes.execute).toHaveBeenCalled();
    expect(present.row).toMatchObject({
      state: "running",
      kind: "kubernetes",
      providerRef: "pod-1",
    });
    expect(docker).not.toHaveBeenCalled();
    expect(desktop).not.toHaveBeenCalled();
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("checkpoints and destroys the loaded computer rather than a precomputed engine", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-loaded-engine-"));
  const stale = {
    describe: () => ({ id: "docker" }),
    destroy: vi.fn(async () => undefined),
    releaseScreen: vi.fn(async () => undefined),
  };
  const hostDestroy = vi
    .spyOn(DesktopSandboxProvider.prototype, "destroy")
    .mockResolvedValue(undefined);
  const computer = storedComputer({
    kind: "desktop",
    providerRef: "host:home",
    state: "running",
    connectionId: null,
  });
  const sandbox = createRunSandbox("docker", {
    prisma: {
      deploymentSettings: { findUnique: async () => ({ computerHost: "this-mac" }) },
    } as unknown as PrismaClient,
    secrets: { load: () => "" },
  });
  try {
    await expect(
      replaceComputer(
        {
          prisma: { computer, run: { findFirst: async () => null } } as unknown as PrismaClient,
          home: new LocalAgentHomeStore(homeRoot),
          sandbox,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer",
        "update",
        runContext,
        "none",
        undefined,
        { imageProfile: "base", connectionId: null },
        {
          source: stale as unknown as SandboxProvider,
          target: stale as unknown as SandboxProvider,
        },
      ),
    ).rejects.toThrow();
    expect(stale.destroy).not.toHaveBeenCalled();
    expect(hostDestroy).toHaveBeenCalled();
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});
