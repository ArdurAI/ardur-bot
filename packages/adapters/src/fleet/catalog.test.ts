import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { E2BSandboxProvider } from "../e2b-sandbox.js";
import { FakeSandboxProvider } from "../fake-sandbox.js";
import { LocalAgentHomeStore } from "../home.js";
import { createRunSandbox, HostAwareSandbox, owningSandbox } from "../host-aware-sandbox.js";
import { KubernetesSandboxProvider } from "../kubernetes-sandbox.js";
import { FakeKubernetesApi } from "../kubernetes-test-api.js";
import { RemoteHostSandboxProvider } from "../remote-host-sandbox.js";
import { createSandboxProvider } from "../sandbox-factory.js";
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
    hostRegistration: { findUnique: async () => null },
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
    hostRegistration: { findUnique: async () => null },
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
    describe: () => ({ id: "kubernetes", kind: "kubernetes" }),
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
    catalog.compatibleTargets(
      await catalog.engineFamily(computer, context),
      [docker!, kubernetes!],
      context,
    ),
  ).resolves.toEqual([docker]);
  await expect(catalog.placementTarget("docker", kubernetes!, context)).rejects.toThrow(
    "Computer replacement target is unavailable",
  );
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
    hostRegistration: { findUnique: async () => null },
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
    catalog.placementTarget(await catalog.engineFamily(computer, context), host!, context),
  ).rejects.toThrow("Computer replacement target is unavailable");
});

it("completes a Settings connection change from Docker to Kubernetes and refuses that placement", async () => {
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-settings-home-"));
  const kubernetes = new FakeSandboxProvider();
  const described = kubernetes.describe();
  vi.spyOn(kubernetes, "describe").mockReturnValue({
    ...described,
    id: "kubernetes",
    kind: "kubernetes",
  });
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
    hostRegistration: { findUnique: async () => null },
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
  const { sandbox } = kubernetesDefault(prisma);
  const catalog = new FleetCatalog(
    prisma as unknown as PrismaClient,
    { load: () => "" },
    {},
    sandbox,
  );
  vi.spyOn(ComputerConnections.prototype, "resolve").mockResolvedValue(kubernetes);
  const cluster = { kind: "kubernetes" as const, connectionId: "k8s" };
  try {
    await expect(
      catalog.placementTarget(await catalog.engineFamily(computer, context), cluster, context),
    ).rejects.toThrow("Computer replacement target is unavailable");
    expect(destroy).not.toHaveBeenCalled();
    await performComputerUpdate(
      {
        prisma: prisma as unknown as PrismaClient,
        sandbox,
        home: new LocalAgentHomeStore(homeRoot),
        jobs: { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
        events: {} as ThreadEvents,
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
      hostRegistration: { findUnique: async () => null },
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
    describe: () => ({ id: "docker", kind: "docker" }),
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
    hostRegistration: { findUnique: async () => null },
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
  const prisma = {
    computer,
    run: { findFirst: async () => null },
    deploymentSettings: { findUnique: async () => null },
  };
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
      ),
    ).rejects.toThrow("cluster is full");
    expect(podman.destroy).toHaveBeenCalledOnce();
    expect(computer.row).toMatchObject({ state: "error", connectionId: null, kind: "kubernetes" });
    await expect(catalog.resolveComputer(computer.row, context)).resolves.toBeInstanceOf(
      KubernetesSandboxProvider,
    );
  } finally {
    api.dispose();
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("moves a Docker computer to a saved connection with the host bridge on, never through the host", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-host-bridge-move-"));
  const homeFile = path.join(homeRoot, "homes", "home", "notes", "keep.txt");
  await mkdir(path.dirname(homeFile), { recursive: true });
  await writeFile(homeFile, "saved");
  const hostCalls: string[] = [];
  const hostClient = {
    health: async () => null,
    result: async (operation: { op: string }) => {
      hostCalls.push(operation.op);
      return undefined;
    },
    request: async function* (operation: { op: string }) {
      hostCalls.push(operation.op);
      yield* [];
    },
  };
  vi.spyOn(DockerSandboxProvider.prototype, "releaseScreen").mockResolvedValue(undefined);
  const destroy = vi.spyOn(DockerSandboxProvider.prototype, "destroy").mockResolvedValue(undefined);
  const dockerExport = vi
    .spyOn(DockerSandboxProvider.prototype, "exportWorkspace")
    .mockImplementation(async function* () {
      yield { path: "notes/keep.txt", content: new TextEncoder().encode("saved") };
    });
  const destination = new FakeSandboxProvider();
  vi.spyOn(ComputerConnections.prototype, "resolve").mockResolvedValue(destination);
  const computer = storedComputer({ maintenanceId: "update-1", state: "running" });
  const prisma = {
    deploymentSettings: { findUnique: async () => ({ computerHost: "this-mac" }) },
    computer,
    run: { findFirst: async () => null },
  };
  const sandbox = createRunSandbox("docker", {
    prisma: prisma as unknown as PrismaClient,
    secrets: { load: () => "" },
    hostClient,
  });
  try {
    await replaceComputer(
      {
        prisma: prisma as unknown as PrismaClient,
        sandbox,
        home: new LocalAgentHomeStore(homeRoot),
        jobs: {} as JobPublisher,
        events: {} as ThreadEvents,
      },
      computer.row.id,
      "update",
      { ...runContext, runId: undefined, operationId: "update-1" },
      "none",
      undefined,
      { imageProfile: "base", connectionId: "engine" },
    );
    expect(dockerExport).toHaveBeenCalledOnce();
    expect(hostCalls).toEqual([]);
    expect(destroy).toHaveBeenCalledOnce();
    expect(await readFile(homeFile, "utf8")).toBe("saved");
    const imported = [...destination.boxes.values()].flatMap((box) => [...box.files.entries()]);
    expect(
      new TextDecoder().decode(imported.find(([file]) => file === "notes/keep.txt")![1].content),
    ).toBe("saved");
    expect(computer.row).toMatchObject({ connectionId: "engine", providerRef: expect.any(String) });
    expect(computer.row.kind).not.toBe("desktop");
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("keeps an image profile change on the host when the connection is left alone", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-desktop-profile-"));
  const dockerProvision = vi.spyOn(DockerSandboxProvider.prototype, "provision");
  vi.spyOn(DesktopSandboxProvider.prototype, "destroy").mockResolvedValue(undefined);
  vi.spyOn(DesktopSandboxProvider.prototype, "prepare").mockResolvedValue(undefined);
  const hostProvision = vi.spyOn(DesktopSandboxProvider.prototype, "provision").mockResolvedValue({
    id: "host:home",
    botId: "home",
    kind: "desktop",
    providerRef: "host:home",
    fresh: false,
  });
  const computer = storedComputer({
    kind: "desktop",
    providerRef: "host:home",
    connectionId: null,
    imageProfile: "base",
    maintenanceId: "update-1",
    state: "running",
  });
  const configuration = { imageProfile: "developer" as const, confirmed: true as const };
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
    hostRegistration: { findUnique: async () => null },
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
  try {
    await performComputerUpdate(
      {
        prisma: prisma as unknown as PrismaClient,
        sandbox,
        home: new LocalAgentHomeStore(homeRoot),
        jobs: { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
        events: {} as ThreadEvents,
      },
      update.id,
    );
    expect(update.status).toBe("completed");
    expect(dockerProvision).not.toHaveBeenCalled();
    expect(hostProvision).toHaveBeenCalledWith(
      expect.objectContaining({ providerKind: "desktop", imageProfile: "developer" }),
      expect.any(Object),
    );
    expect(computer.row).toMatchObject({
      state: "running",
      kind: "desktop",
      connectionId: null,
      providerRef: "host:home",
      imageProfile: "developer",
    });
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("runs a connectionless Kubernetes computer only on a Kubernetes deployment", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-k8s-kind-"));
  const provision = vi
    .spyOn(KubernetesSandboxProvider.prototype, "provision")
    .mockImplementation(async (request) => ({
      id: "pod",
      botId: request.botId,
      kind: "kubernetes",
      providerRef: request.providerRef ?? "pod-1",
      fresh: false,
    }));
  vi.spyOn(KubernetesSandboxProvider.prototype, "prepare").mockResolvedValue(undefined);
  const deps = (sandbox: SandboxProvider, computer: ReturnType<typeof storedComputer>) => ({
    prisma: { computer } as unknown as PrismaClient,
    home: new LocalAgentHomeStore(homeRoot),
    sandbox,
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
  });
  const onDocker = storedComputer({ kind: "kubernetes", providerRef: "pod-1" });
  const dockerDeployment = createRunSandbox("docker", {
    prisma: {
      deploymentSettings: { findUnique: async () => null },
      computer: onDocker,
    } as unknown as PrismaClient,
    secrets: { load: () => "" },
  });
  const onKubernetes = storedComputer({ kind: "kubernetes", providerRef: "pod-1" });
  const { api, sandbox } = kubernetesDefault({ computer: onKubernetes });
  try {
    await expect(
      provisionComputer(deps(dockerDeployment, onDocker), "computer", runContext, "bot"),
    ).rejects.toThrow(
      "This computer runs on Kubernetes, which is not configured here. Reset it in Settings, Computers to start it on this deployment's engine, or configure Kubernetes again.",
    );
    expect(onDocker.updateMany).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    await provisionComputer(deps(sandbox, onKubernetes), "computer", runContext, "bot");
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "pod-1", providerKind: "kubernetes" }),
      runContext,
    );
    expect(onKubernetes.row).toMatchObject({ state: "running", kind: "kubernetes" });
  } finally {
    api.dispose();
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("never traps a computer whose E2B key was removed", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-missing-engine-"));
  const homeFile = path.join(homeRoot, "homes", "home", "notes", "keep.txt");
  await mkdir(path.dirname(homeFile), { recursive: true });
  await writeFile(homeFile, "saved");
  const e2b = [
    vi.spyOn(E2BSandboxProvider.prototype, "provision"),
    vi.spyOn(E2BSandboxProvider.prototype, "exportWorkspace"),
    vi.spyOn(E2BSandboxProvider.prototype, "destroy"),
  ];
  const docker = localDocker({ id: "docker-new", providerRef: "docker-new", fresh: true });
  const office = new FakeSandboxProvider();
  vi.spyOn(ComputerConnections.prototype, "resolve").mockResolvedValue(office);
  const notes: unknown[] = [];
  const computerWithoutKey = () => {
    const computer = storedComputer({ kind: "e2b", providerRef: "e2b-1" });
    const prisma = {
      computer,
      run: { findFirst: async () => null },
      deploymentSettings: { findUnique: async () => null },
      thread: {
        findFirst: async () => ({ id: "thread" }),
        update: async () => ({ nextEventSeq: 2, nextMessageSeq: 2 }),
      },
      message: {
        create: async ({ data }: { data: { blocks: unknown } }) => {
          notes.push(data.blocks);
          return { id: "message" };
        },
      },
      event: { create: async () => ({ seq: 1, type: "thread.message.created" }) },
      $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
    };
    const deps = {
      prisma: prisma as unknown as PrismaClient,
      home: new LocalAgentHomeStore(homeRoot),
      sandbox: createRunSandbox("docker", {
        prisma: prisma as unknown as PrismaClient,
        secrets: { load: () => "" },
      }),
      jobs: {} as JobPublisher,
      events: { notify: vi.fn(async () => undefined) } as unknown as ThreadEvents,
    };
    return { computer, deps };
  };
  const restored = [
    {
      kind: "text",
      text: "The previous engine was not available, so the last saved workspace was restored.",
    },
  ];
  try {
    const run = computerWithoutKey();
    await expect(provisionComputer(run.deps, "computer", runContext, "bot")).rejects.toThrow(
      "This computer runs on E2B, which is not configured here. Reset it in Settings, Computers to start it on this deployment's engine, or configure E2B again.",
    );
    expect(run.computer.updateMany).not.toHaveBeenCalled();

    const moved = computerWithoutKey();
    await replaceComputer(moved.deps, "computer", "update", runContext, "none", undefined, {
      imageProfile: "base",
      connectionId: "office",
    });
    expect(moved.computer.row).toMatchObject({ state: "running", connectionId: "office" });
    const files = [...office.boxes.values()].flatMap((box) => [...box.files.entries()]);
    expect(
      new TextDecoder().decode(files.find(([file]) => file === "notes/keep.txt")![1].content),
    ).toBe("saved");
    expect(notes).toEqual([restored]);

    const reset = computerWithoutKey();
    await replaceComputer(reset.deps, "computer", "reset", runContext);
    expect(docker.provision).toHaveBeenCalledOnce();
    expect(reset.computer.row).toMatchObject({
      state: "running",
      kind: "docker",
      connectionId: null,
      providerRef: "docker-new",
    });
    expect(await readFile(homeFile, "utf8")).toBe("saved");
    expect(notes).toEqual([restored, restored]);
    for (const call of e2b) expect(call).not.toHaveBeenCalled();
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

function lostEngineDeps(
  computer: ReturnType<typeof storedComputer>,
  sandbox: (prisma: PrismaClient) => SandboxProvider,
  homeRoot: string,
  computerHost: string | null,
) {
  const notes: unknown[] = [];
  const prisma = {
    computer,
    run: { findFirst: async () => null },
    deploymentSettings: { findUnique: async () => ({ computerHost }) },
    thread: {
      findFirst: async () => ({ id: "thread" }),
      update: async () => ({ nextEventSeq: 2, nextMessageSeq: 2 }),
    },
    message: {
      create: async ({ data }: { data: { blocks: unknown } }) => {
        notes.push(data.blocks);
        return { id: "message" };
      },
    },
    event: { create: async () => ({ seq: 1, type: "thread.message.created" }) },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  };
  return {
    notes,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      home: new LocalAgentHomeStore(homeRoot),
      sandbox: sandbox(prisma as unknown as PrismaClient),
      jobs: {} as JobPublisher,
      events: { notify: vi.fn(async () => undefined) } as unknown as ThreadEvents,
    },
  };
}

it("never restores a computer whose engine is gone onto the host", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-lost-engine-host-"));
  const provision = vi.spyOn(RemoteHostSandboxProvider.prototype, "provision");
  const hostClient = {
    request: vi.fn(),
    result: vi.fn(async () => undefined),
    health: vi.fn(async () => null),
  };
  try {
    for (const mode of ["reset", "recover"] as const) {
      const computer = storedComputer({ kind: "e2b", providerRef: "e2b-1" });
      const { deps, notes } = lostEngineDeps(
        computer,
        (prisma) =>
          createRunSandbox("desktop", {
            hostClient: hostClient as never,
            prisma,
            secrets: { load: () => "" },
          }),
        homeRoot,
        null,
      );
      await expect(replaceComputer(deps, "computer", mode, runContext)).rejects.toThrow(
        "Moving a computer onto the machine running Ardur Bot is not available yet. Choose a saved connection or keep the current engine.",
      );
      expect(computer.updateMany).not.toHaveBeenCalled();
      expect(notes).toEqual([]);
    }
    expect(provision).not.toHaveBeenCalled();
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("resets a host computer onto Docker once This Mac is off", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-host-off-"));
  const host = [
    vi.spyOn(DesktopSandboxProvider.prototype, "provision"),
    vi.spyOn(DesktopSandboxProvider.prototype, "destroy"),
    vi.spyOn(DesktopSandboxProvider.prototype, "execute"),
  ];
  const docker = localDocker({ id: "docker-new", providerRef: "docker-new", fresh: true });
  const computer = storedComputer({ kind: "desktop", providerRef: "/workspace" });
  const { deps, notes } = lostEngineDeps(
    computer,
    (prisma) => createRunSandbox("docker", { prisma, secrets: { load: () => "" } }),
    homeRoot,
    "docker",
  );
  try {
    await expect(provisionComputer(deps, "computer", runContext, "bot")).rejects.toThrow(
      /^This computer runs on This (Mac|computer), which is not configured here\./,
    );
    await replaceComputer(deps, "computer", "reset", runContext);
    expect(docker.provision).toHaveBeenCalledOnce();
    expect(computer.row).toMatchObject({
      state: "running",
      kind: "docker",
      providerRef: "docker-new",
    });
    expect(notes).toHaveLength(1);
    for (const call of host) expect(call).not.toHaveBeenCalled();
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("provisions, prepares and destroys an e2b-emulator computer on its own provider", async () => {
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-emulator-"));
  const computer = storedComputer({ kind: "e2b-emulator", providerRef: null, state: "stopped" });
  const prisma = { computer, run: { findFirst: async () => null } };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    home: new LocalAgentHomeStore(homeRoot),
    sandbox: createRunSandbox("e2b-emulator", {
      prisma: prisma as unknown as PrismaClient,
      secrets: { load: () => "" },
    }),
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
  };
  const prepare = vi.spyOn(FakeSandboxProvider.prototype, "prepare");
  const destroy = vi.spyOn(FakeSandboxProvider.prototype, "destroy");
  try {
    await provisionComputer(deps, "computer", runContext, "bot");
    expect(computer.row).toMatchObject({ state: "running", kind: "e2b" });
    await replaceComputer(deps, "computer", "reset", runContext);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
    expect(computer.row).toMatchObject({ state: "running", kind: "e2b" });
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("provisions a connectionless E2B computer when its key is set and leaves the row without one", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-e2b-kind-"));
  const provision = vi.spyOn(E2BSandboxProvider.prototype, "provision").mockResolvedValue({
    id: "sandbox",
    botId: "home",
    kind: "e2b",
    providerRef: "e2b-1",
    fresh: false,
  });
  vi.spyOn(E2BSandboxProvider.prototype, "prepare").mockResolvedValue(undefined);
  const docker = vi.spyOn(DockerSandboxProvider.prototype, "provision");
  const missing = storedComputer({
    kind: "e2b",
    providerRef: "e2b-1",
    state: "running",
    connectionId: null,
  });
  const present = storedComputer({
    id: "computer-e2b",
    kind: "e2b",
    providerRef: "e2b-1",
    state: "running",
    connectionId: null,
  });
  const settings = { findUnique: async () => ({ computerHost: "docker" }) };
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
    ).rejects.toThrow(
      "This computer runs on E2B, which is not configured here. Reset it in Settings, Computers to start it on this deployment's engine, or configure E2B again.",
    );
    expect(missing.updateMany).not.toHaveBeenCalled();
    expect(missing.row).toMatchObject({ state: "running", kind: "e2b", providerRef: "e2b-1" });
    expect(docker).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();

    const sandbox = createRunSandbox("docker", {
      e2bApiKey: "test-key",
      prisma: { deploymentSettings: settings, computer: present } as unknown as PrismaClient,
      secrets: { load: () => "" },
    });
    await provisionComputer(
      {
        prisma: { computer: present } as unknown as PrismaClient,
        home: new LocalAgentHomeStore(homeRoot),
        sandbox,
        jobs: {} as JobPublisher,
        events: {} as ThreadEvents,
      },
      "computer-e2b",
      runContext,
      "bot",
    );
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "e2b-1", providerKind: "e2b" }),
      runContext,
    );
    expect(present.row).toMatchObject({ state: "running", kind: "e2b", providerRef: "e2b-1" });
    expect(docker).not.toHaveBeenCalled();
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("moves a local Docker computer to a remote Docker engine and never to SSH", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-docker-family-"));
  vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockResolvedValue({
    name: "docker",
    rootless: false,
    version: "test",
    os: "linux",
    capacity: { ...unknownCapacity(), source: "docker", memoryFree: 512 * 1024 ** 2 },
  });
  const docker = localDocker({ providerRef: "docker-new", fresh: true });
  vi.spyOn(DockerSandboxProvider.prototype, "exportWorkspace").mockImplementation(
    async function* () {
      yield { path: "notes/keep.txt", content: new TextEncoder().encode("saved") };
    },
  );
  const measured = (id: "remote-docker" | "ssh", memoryFree: number) => ({
    describe: () => ({ id, kind: id }),
    capacity: async () => ({
      ...unknownCapacity(),
      source: id === "ssh" ? ("ssh" as const) : ("docker" as const),
      memoryFree,
    }),
    provision: vi.fn(async () => ({
      id: `${id}-computer`,
      botId: "home",
      kind: id,
      providerRef: `${id}-computer`,
      fresh: true,
    })),
    prepare: async () => undefined,
    importWorkspace: async () => undefined,
    releaseScreen: async () => undefined,
    destroy: vi.fn(async () => undefined),
  });
  const remote = measured("remote-docker", 8 * 1024 ** 3);
  const ssh = measured("ssh", 32 * 1024 ** 3);
  vi.spyOn(ComputerConnections.prototype, "resolve").mockImplementation(async (id: string) => {
    if (id === "remote-engine") return remote as unknown as SandboxProvider;
    if (id === "ssh-machine") return ssh as unknown as SandboxProvider;
    throw new Error("The computer connection is unavailable; choose a connection in Settings.");
  });
  const computer = storedComputer();
  const prisma = {
    connection: {
      findMany: async () => [
        {
          id: "remote-engine",
          displayName: "Remote Docker",
          status: "connected",
          metadata: { engine: "docker", dockerContext: "remote" },
        },
        {
          id: "ssh-machine",
          displayName: "Linux machine",
          status: "connected",
          metadata: { engine: "ssh", ssh: { host: "computer.invalid", user: "runner" } },
        },
      ],
    },
    bot: {
      findMany: async () => [{ ...movingBot, computer: computer.row }],
      updateMany: async () => ({ count: 1 }),
    },
    space: { findUniqueOrThrow: async () => ({ placement: { mode: "free-memory" } }) },
    deploymentSettings: { findUnique: async () => ({ computerHost: null }) },
    hostRegistration: { findUnique: async () => null },
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
  const context: AdapterContext = { ...runContext, operationId: "place", traceId: "place" };
  try {
    const fleet = await catalog.list(context);
    const compatible = await catalog.compatibleTargets(
      await catalog.engineFamily(computer.row, context),
      fleet.targets,
      context,
    );
    expect(compatible.map((target) => target.id)).toEqual(
      expect.arrayContaining(["remote-engine"]),
    );
    expect(compatible.map((target) => target.id)).not.toContain("ssh-machine");
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
      new AbortController().signal,
    );
    expect(moved).toBe(true);
    expect(computer.row).toMatchObject({
      connectionId: "remote-engine",
      kind: "remote-docker",
    });
    expect(remote.provision).toHaveBeenCalledOnce();
    expect(ssh.provision).not.toHaveBeenCalled();
    expect(ssh.destroy).not.toHaveBeenCalled();
    expect(docker.destroy).toHaveBeenCalled();
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

function listingPrisma(
  computers: { kind: string; connectionId?: string | null }[],
  pairedPlatform: string | null = null,
) {
  return {
    connection: { findMany: async () => [] },
    bot: {
      findMany: async () =>
        computers.map((computer, index) => ({
          id: `bot-${index}`,
          name: `Bot ${index}`,
          computer: { connectionId: null, ...computer },
        })),
    },
    space: { findUniqueOrThrow: async () => ({ placement: {} }) },
    deploymentSettings: { findUnique: async () => ({ computerHost: null }) },
    hostRegistration: {
      findUnique: async () => (pairedPlatform ? { platform: pairedPlatform } : null),
    },
  } as unknown as PrismaClient;
}

function rows(fleet: Awaited<ReturnType<FleetCatalog["list"]>>) {
  return fleet.targets.map(({ id, builtin, name, kind, bots }) => ({
    id,
    builtin,
    name,
    kind,
    bots: bots.map((bot) => bot.id),
  }));
}

it("keys the built-in rows and labels the host from the paired desktop, else the server", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockRejectedValue(new Error("offline"));
  const provider = (kind: string) =>
    ({
      describe: () => ({ id: kind, kind }),
      capacity: async () => unknownCapacity(),
    }) as unknown as SandboxProvider;
  const list = (fallback: SandboxProvider, paired: string | null) =>
    new FleetCatalog(listingPrisma([], paired), { load: () => "" }, {}, fallback).list(runContext);
  const onMac = await list(provider("docker"), "darwin");
  expect(onMac.hostLabel).toBe("This Mac");
  expect(rows(onMac)).toEqual([
    { id: "host", builtin: "host", name: "This Mac", kind: "host", bots: [] },
    {
      id: "default",
      builtin: "local-docker",
      name: "Docker on this Mac",
      kind: "docker",
      bots: [],
    },
  ]);
  const onLinux = await list(provider("e2b"), "linux");
  expect(onLinux.hostLabel).toBe("This computer");
  expect(rows(onLinux).map(({ id, builtin, name }) => ({ id, builtin, name }))).toEqual([
    { id: "host", builtin: "host", name: "This computer" },
    { id: "default", builtin: "default", name: "Default computer" },
    { id: "docker", builtin: "local-docker", name: "Docker on this computer" },
  ]);
  expect((await list(provider("docker"), null)).hostLabel).toBe(
    process.platform === "darwin" ? "This Mac" : "This computer",
  );
});

it.each([
  ["none", "none", null, "default"],
  ["fake", "fake", "fake", "default"],
  ["e2b-emulator", "e2b-emulator", "e2b", "e2b"],
  ["e2b-emulator", "e2b", "e2b", "e2b"],
] as const)(
  "lists a %s deployment's %s computer on the default row",
  async (provider, computerKind, created, rowKind) => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
    vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockRejectedValue(new Error("offline"));
    const fallback = createSandboxProvider(provider, {});
    expect(fallback.describe().kind).toBe(created);
    const fleet = await new FleetCatalog(
      listingPrisma([{ kind: computerKind }]),
      { load: () => "" },
      {},
      fallback,
    ).list(runContext);
    expect(fleet.targets.find((target) => target.id === "default")).toMatchObject({
      builtin: "default",
      kind: rowKind,
      bots: [{ id: "bot-0", name: "Bot 0" }],
    });
    expect(fleet.targets.filter((target) => target.id.startsWith("kind:"))).toEqual([]);
  },
);

it("lists no row for a computer whose engine is not configured and never moves it", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
  vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockResolvedValue({
    name: "docker",
    rootless: false,
    version: "test",
    os: "linux",
    capacity: { ...unknownCapacity(), source: "docker", memoryFree: 32 * 1024 ** 3 },
  });
  for (const kind of ["kubernetes", "e2b"]) {
    const computer = storedComputer({ kind, providerRef: `${kind}-1` });
    const row = { ...computer.row, bots: [movingBot] };
    const prisma = {
      connection: { findMany: async () => [] },
      bot: { findMany: async () => [{ ...movingBot, computer: row }], update: vi.fn() },
      space: { findUniqueOrThrow: async () => ({ placement: { mode: "free-memory" } }) },
      deploymentSettings: { findUnique: async () => ({ computerHost: null }) },
      hostRegistration: { findUnique: async () => null },
      run: { findUniqueOrThrow: async () => runRow(row), updateMany: vi.fn() },
      computer,
      computerUpdate: { create: vi.fn() },
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
    const fleet = await catalog.list(runContext);
    expect(rows(fleet).map(({ id, bots }) => ({ id, bots }))).toEqual([
      { id: "host", bots: [] },
      { id: "default", bots: [] },
    ]);
    expect(
      await placeRunComputer(
        {
          prisma: prisma as unknown as PrismaClient,
          home: {} as AgentHomeStore,
          sandbox,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        catalog,
        "run",
        new AbortController().signal,
      ),
    ).toBe(true);
    expect(prisma.computerUpdate.create).not.toHaveBeenCalled();
    expect(computer.updateMany).not.toHaveBeenCalled();
  }
});

it("shows a registered E2B computer's capacity on a Docker deployment", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const memoryFree = 16 * 1024 ** 3;
  const capacity = vi
    .spyOn(E2BSandboxProvider.prototype, "capacity")
    .mockResolvedValue({ ...unknownCapacity(), source: "docker", memoryFree });
  vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockResolvedValue({
    name: "docker",
    rootless: false,
    version: "test",
    os: "linux",
    capacity: { ...unknownCapacity(), source: "docker", memoryFree: 512 * 1024 ** 2 },
  });
  const prisma = listingPrisma([{ kind: "e2b" }]);
  const sandbox = createRunSandbox("docker", {
    prisma,
    secrets: { load: () => "" },
    e2bApiKey: "e2b-test",
  });
  const fleet = await new FleetCatalog(prisma, { load: () => "" }, {}, sandbox).list(runContext);
  expect(capacity).toHaveBeenCalledOnce();
  expect(rows(fleet)).toEqual([
    { id: "host", builtin: "host", name: expect.any(String), kind: "host", bots: [] },
    {
      id: "default",
      builtin: "local-docker",
      name: expect.any(String),
      kind: "docker",
      bots: [],
    },
    { id: "kind:e2b", builtin: undefined, name: "E2B", kind: "e2b", bots: ["bot-0"] },
  ]);
  expect(fleet.targets.at(-1)).toMatchObject({
    state: "connected",
    capacity: expect.objectContaining({ memoryFree }),
  });
});

it.each(["e2b", "daytona", "box"] as const)(
  "puts a connectionless %s computer on the deployment default with that provider's capacity",
  async (kind) => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "");
    const memoryFree = 24 * 1024 ** 3;
    const capacity = {
      ...unknownCapacity(),
      source: "docker" as const,
      memoryFree,
    };
    vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockResolvedValue({
      name: "docker",
      rootless: false,
      version: "test",
      os: "linux",
      capacity: { ...unknownCapacity(), source: "docker", memoryFree: 512 * 1024 ** 2 },
    });
    const fallback = {
      describe: () => ({ id: kind, kind }),
      capacity: async () => capacity,
    } as unknown as SandboxProvider;
    const prisma = {
      connection: { findMany: async () => [] },
      bot: {
        findMany: async () => [
          {
            id: "bot",
            name: "Bot",
            computer: { kind, connectionId: null },
          },
        ],
      },
      space: { findUniqueOrThrow: async () => ({ placement: {} }) },
      deploymentSettings: { findUnique: async () => ({ computerHost: null }) },
      hostRegistration: { findUnique: async () => null },
    };
    const context: AdapterContext = {
      userId: "owner",
      spaceId: "space",
      operationId: "list",
      traceId: "list",
      signal: new AbortController().signal,
    };
    const fleet = await new FleetCatalog(
      prisma as unknown as PrismaClient,
      { load: () => "" },
      {},
      fallback,
    ).list(context);
    const row = fleet.targets.find((target) => target.id === fleet.defaultTargetId);
    expect(row).toMatchObject({
      id: "default",
      kind,
      state: "connected",
      capacity: expect.objectContaining({ memoryFree }),
      bots: [{ id: "bot", name: "Bot" }],
    });
    expect(fleet.targets.filter((target) => target.kind === kind)).toHaveLength(1);
    expect(fleet.targets.some((target) => target.id === `kind:${kind}`)).toBe(false);
    expect(
      fleet.targets.find((target) => target.connectionId === null && target.kind === "docker")
        ?.bots,
    ).toEqual([]);
  },
);

it("boots a docker row on its saved connection and keeps the kind that connection reports", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-kind-connection-"));
  // Each fake reports the kind its real provider reports for a computer it boots.
  const connected = (id: "ssh" | "remote-docker") => ({
    describe: () => ({ id, kind: id }),
    provision: vi.fn(async (request: { botId: string }) => ({
      id: `${id}-computer`,
      botId: request.botId,
      kind: id,
      providerRef: `${id}-computer`,
      fresh: false,
    })),
    prepare: vi.fn(async () => undefined),
    importWorkspace: vi.fn(async () => undefined),
    releaseScreen: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  });
  const ssh = connected("ssh");
  const remote = connected("remote-docker");
  vi.spyOn(ComputerConnections.prototype, "resolve").mockImplementation(async (id: string) => {
    if (id === "ssh-machine") return ssh as unknown as SandboxProvider;
    if (id === "remote-engine") return remote as unknown as SandboxProvider;
    throw new Error("The computer connection is unavailable; choose a connection in Settings.");
  });
  const docker = vi.spyOn(DockerSandboxProvider.prototype, "provision");
  const boot = async (connectionId: string) => {
    const computer = storedComputer({
      kind: "docker",
      connectionId,
      providerRef: "docker-computer",
      state: "stopped",
    });
    const prisma = {
      deploymentSettings: { findUnique: async () => ({ computerHost: null }) },
      hostRegistration: { findUnique: async () => null },
      computer,
    };
    const sandbox = createRunSandbox("docker", {
      prisma: prisma as unknown as PrismaClient,
      secrets: { load: () => "" },
    });
    await provisionComputer(
      {
        prisma: prisma as unknown as PrismaClient,
        home: new LocalAgentHomeStore(homeRoot),
        sandbox,
        jobs: {} as JobPublisher,
        events: {} as ThreadEvents,
      },
      "computer",
      runContext,
      "bot",
    );
    return computer;
  };
  const states = (computer: ReturnType<typeof storedComputer>) =>
    computer.updateMany.mock.calls.map((call) => call[0].data.state);
  try {
    const onSsh = await boot("ssh-machine");
    expect(ssh.provision).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "ssh-machine", providerKind: "docker" }),
      runContext,
    );
    expect(onSsh.row).toMatchObject({
      state: "running",
      kind: "ssh",
      connectionId: "ssh-machine",
      providerRef: "ssh-computer",
    });
    expect(states(onSsh)).not.toContain("error");

    const onRemote = await boot("remote-engine");
    expect(remote.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "remote-engine",
        providerKind: "docker",
        providerRef: "docker-computer",
      }),
      runContext,
    );
    expect(onRemote.row).toMatchObject({
      state: "running",
      kind: "remote-docker",
      connectionId: "remote-engine",
    });
    expect(states(onRemote)).not.toContain("error");
    expect(docker).not.toHaveBeenCalled();
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

it("refuses to clear a connection while the deployment default is the host", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const podman = savedPodman();
  vi.spyOn(ComputerConnections.prototype, "resolve").mockResolvedValue(podman);
  const computer = storedComputer({ connectionId: "engine", providerRef: "podman-computer" });
  const prisma = {
    computer,
    run: { findFirst: async () => null },
    deploymentSettings: { findUnique: async () => ({ computerHost: "this-mac" }) },
  };
  const sandbox = createRunSandbox("docker", {
    prisma: prisma as unknown as PrismaClient,
    secrets: { load: () => "" },
  });
  await expect(
    replaceComputer(
      {
        prisma: prisma as unknown as PrismaClient,
        home: {} as AgentHomeStore,
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
    ),
  ).rejects.toThrow(
    "Moving a computer onto the machine running Ardur Bot is not available yet. Choose a saved connection or keep the current engine.",
  );
  expect(podman.destroy).not.toHaveBeenCalled();
  expect(computer.updateMany).not.toHaveBeenCalled();
});

it("lists registered E2B, Daytona and Box computers as available with unknown capacity", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockRejectedValue(new Error("offline"));
  const keys = { e2bApiKey: "e2b-test", daytonaApiKey: "daytona-test", boxApiKey: "box-test" };
  const prisma = listingPrisma([{ kind: "e2b" }, { kind: "daytona" }, { kind: "box" }]);
  const list = (kind: string) =>
    new FleetCatalog(
      prisma,
      { load: () => "" },
      {},
      createRunSandbox(kind, { ...keys, prisma, secrets: { load: () => "" } }),
    ).list(runContext);
  const state = (fleet: Awaited<ReturnType<typeof list>>, id: string) => {
    const target = fleet.targets.find((row) => row.id === id);
    return target && { state: target.state, source: target.capacity.source };
  };
  const docker = await list("docker");
  for (const id of ["kind:e2b", "kind:daytona", "kind:box"])
    expect(state(docker, id)).toEqual({ state: "connected", source: "not-reported" });
  expect(state(await list("e2b"), "default")).toEqual({
    state: "connected",
    source: "not-reported",
  });
});

it.each([
  [null, false],
  ["this-mac", true],
] as const)(
  "lists a host computer on the host row only while This Mac is %s",
  async (computerHost, listed) => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
    vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockRejectedValue(new Error("offline"));
    const prisma = {
      ...listingPrisma([{ kind: "desktop" }]),
      deploymentSettings: { findUnique: async () => ({ computerHost }) },
    } as unknown as PrismaClient;
    const sandbox = createRunSandbox("docker", { prisma, secrets: { load: () => "" } });
    const fleet = await new FleetCatalog(prisma, { load: () => "" }, {}, sandbox).list(runContext);
    expect(fleet.targets.filter((target) => target.bots.length).map((target) => target.id)).toEqual(
      listed ? ["host"] : [],
    );
  },
);

it("resolves the source engine once and probes placement candidates four at a time", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  let inFlight = 0;
  let most = 0;
  const findFirst = vi.fn(async ({ where }: { where: { id: string } }) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return {
      id: where.id,
      userId: "owner",
      secretId: null,
      metadata: { engine: "docker", socket: "/var/run/docker.sock" },
    };
  });
  const prisma = {
    connection: { findFirst },
    deploymentSettings: { findUnique: async () => ({ computerHost: null }) },
  } as unknown as PrismaClient;
  const sandbox = createRunSandbox("docker", { prisma, secrets: { load: () => "" } });
  const catalog = new FleetCatalog(prisma, { load: () => "" }, {}, sandbox);
  const targets = Array.from({ length: 10 }, (_, index) => ({
    id: `engine-${index}`,
    name: `Engine ${index}`,
    kind: "docker" as const,
    connectionId: `engine-${index}`,
    state: "connected" as const,
    capacity: unknownCapacity(),
    bots: [],
  }));
  const family = await catalog.engineFamily(
    { connectionId: "engine-0", kind: "docker" },
    runContext,
  );
  const compatible = await catalog.compatibleTargets(family, targets, runContext);
  expect(compatible).toHaveLength(10);
  expect(findFirst).toHaveBeenCalledTimes(11);
  expect(most).toBeLessThanOrEqual(4);
});

it("moves a Docker computer to an E2B deployment default through Settings", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const homeRoot = await mkdtemp(path.join(tmpdir(), "ardurbot-default-move-"));
  const homeFile = path.join(homeRoot, "homes", "home", "notes", "keep.txt");
  await mkdir(path.dirname(homeFile), { recursive: true });
  await writeFile(homeFile, "saved");
  const docker = localDocker();
  const exported = vi
    .spyOn(DockerSandboxProvider.prototype, "exportWorkspace")
    .mockImplementation(async function* () {
      yield { path: "notes/keep.txt", content: new TextEncoder().encode("exported") };
    });
  const update = (computer: ReturnType<typeof storedComputer>) => {
    const row = {
      id: "update-1",
      computerId: "computer",
      botId: "bot",
      action: "update",
      status: "queued",
      stage: "preparing",
      configuration: { imageProfile: "base", connectionId: null, confirmed: true },
      computer: computer.row,
    };
    const prisma = {
      computer,
      bot: { findFirst: async () => ({ userId: "owner" }) },
      run: { findFirst: async () => null },
      deploymentSettings: { findUnique: async () => ({ computerHost: null }) },
      computerUpdate: {
        findUniqueOrThrow: async () => row,
        updateMany: vi.fn(async ({ data }: { data: object }) => {
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
      $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
    };
    const sandbox = createRunSandbox("e2b-emulator", {
      prisma: prisma as unknown as PrismaClient,
      secrets: { load: () => "" },
    });
    const deps = {
      prisma: prisma as unknown as PrismaClient,
      home: new LocalAgentHomeStore(homeRoot),
      sandbox,
      jobs: { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
      events: { notify: vi.fn(async () => undefined) } as unknown as ThreadEvents,
    };
    return { row, deps, run: () => performComputerUpdate(deps, "update-1") };
  };
  try {
    const onDocker = storedComputer({ kind: "docker", maintenanceId: "update-1" });
    const move = update(onDocker);
    await move.run();
    expect(move.row.status).toBe("completed");
    expect(exported).toHaveBeenCalledOnce();
    expect(docker.destroy).toHaveBeenCalledOnce();
    expect(docker.provision).not.toHaveBeenCalled();
    expect(onDocker.row).toMatchObject({ state: "running", kind: "e2b", connectionId: null });
    const emulator = (await owningSandbox(
      move.deps.sandbox,
      { kind: "e2b" },
      runContext,
    )) as FakeSandboxProvider;
    const files = [...emulator.boxes.values()].flatMap((box) => [...box.files.entries()]);
    expect(
      new TextDecoder().decode(files.find(([file]) => file === "notes/keep.txt")![1].content),
    ).toBe("exported");

    const onDefault = storedComputer({
      kind: "e2b",
      providerRef: "e2b-1",
      maintenanceId: "update-1",
    });
    const stay = update(onDefault);
    await stay.run();
    expect(stay.row.status).toBe("completed");
    expect(onDefault.updateMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ data: { maintenanceId: null } }),
    );
    expect(onDefault.row).toMatchObject({ state: "running", kind: "e2b", providerRef: "e2b-1" });
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});
