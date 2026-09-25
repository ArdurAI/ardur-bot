import type { AdapterContext } from "@ardurbot/adapter-kit";
import { DockerSandboxProvider, FleetCatalog } from "@ardurbot/adapters";
import { unknownCapacity } from "@ardurbot/contracts/fleet";
import type { HostFrame, HostRequest } from "@ardurbot/contracts/host-bridge";
import type { PrismaClient } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import { HostBridge } from "./host-bridge.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("keeps execution capacity while the real fleet catalog probes four saved computers", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
  vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockResolvedValue({
    name: "docker",
    rootless: false,
    capacity: unknownCapacity(),
  });
  const rows = Array.from({ length: 4 }, (_, index) => ({
    id: `connection-${index}`,
    displayName: `Computer ${index}`,
    status: "connected",
    metadata: { engine: "ssh", ssh: { host: "computer.invalid", user: "runner" } },
  }));
  const prisma = {
    connection: {
      findMany: vi.fn(async () => rows),
      findFirst: vi.fn(async ({ where }) => rows.find((row) => row.id === where.id)),
    },
    bot: { findMany: vi.fn(async () => []) },
    space: { findUniqueOrThrow: vi.fn(async () => ({ placement: null })) },
    hostRegistration: {
      findUnique: vi.fn(async () => ({ userId: "owner", generation: "generation" })),
    },
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
    spaceMember: { findFirst: vi.fn(async () => ({})) },
    run: {
      findFirst: vi.fn(async () => ({
        bot: { spaceId: "space", computer: { kind: "desktop", homeKey: "home" } },
      })),
    },
  };
  const bridge = new HostBridge(prisma as unknown as PrismaClient, "fixture-material");
  const sent: HostRequest[] = [];
  const host = {
    send: vi.fn(async (frame: HostFrame) => {
      if (frame.type === "request") sent.push(frame);
    }),
    close: vi.fn(),
  };
  bridge.hub.attach(host, "owner", "generation");
  const catalog = new FleetCatalog(
    prisma as unknown as PrismaClient,
    { load: () => "" },
    {
      hostClient: {
        request: (operation, context) => bridge.fleetRequest(operation, context),
        result: (operation, context) => bridge.fleetResult(operation, context),
        health: async () => bridge.hub.health,
      },
    },
    new DockerSandboxProvider("http://supervisor.invalid"),
  );
  const context: AdapterContext = {
    userId: "owner",
    spaceId: "space",
    operationId: "list",
    traceId: "list",
    signal: new AbortController().signal,
  };
  const listing = catalog.list(context);
  const worker = { send: vi.fn(async (_frame: HostFrame) => {}), close: vi.fn() };
  try {
    await vi.waitFor(() => expect(prisma.connection.findFirst).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    await bridge.hub.request(
      {
        v: 1,
        type: "request",
        id: "execution",
        scope: { userId: "owner", spaceId: "space", botId: "bot", runId: "run" },
        operation: { op: "computer.exec", homeKey: "home", argv: ["echo", "ok"] },
      },
      worker,
    );
    expect(worker.send).not.toHaveBeenCalled();
    expect(sent.some((frame) => frame.id === "execution")).toBe(true);
    const finished = new Set<string>();
    await vi.waitFor(async () => {
      for (const frame of [...sent]) {
        if (frame.id === "execution" || finished.has(frame.id)) continue;
        finished.add(frame.id);
        await bridge.hub.fromHost(host, {
          v: 1,
          type: "stream",
          id: frame.id,
          seq: 0,
          channel: "result",
          data: { ...unknownCapacity(), source: "ssh", memoryFree: 1024 ** 3 },
        });
        await bridge.hub.fromHost(host, { v: 1, type: "end", id: frame.id });
      }
      expect(finished.size).toBe(4);
    });
    const fleet = await listing;
    expect(
      fleet.targets.filter((target) => target.connectionId).map((target) => target.state),
    ).toEqual(Array(4).fill("connected"));
  } finally {
    bridge.hub.detach();
    await listing;
  }
});
