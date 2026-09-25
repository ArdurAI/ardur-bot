import type {
  AdapterContext,
  AgentHomeStore,
  JobPublisher,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import { choosePlacement, unknownCapacity } from "@ardurbot/contracts/fleet";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import { DockerSandboxProvider } from "../docker-sandbox.js";
import { createRunSandbox } from "../host-aware-sandbox.js";
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
