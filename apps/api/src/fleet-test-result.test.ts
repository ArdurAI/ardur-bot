import type { AdapterContext } from "@ardurbot/adapter-kit";
import { FleetTestResultSchema, unknownCapacity } from "@ardurbot/contracts/fleet";
import { expect, it, vi } from "vitest";
import { fleetCatalog, testFleetTarget } from "./fleet.js";
import type { RouterDeps } from "./router.js";

it("returns a typed connection failure while leaving unexpected faults as errors", async () => {
  const prisma = {
    connection: {
      findFirstOrThrow: vi.fn(async () => ({
        metadata: { engine: "docker", endpoint: "unix:///fixture/refused.sock" },
      })),
    },
  };
  const deps = {
    prisma,
    secrets: { load: vi.fn() },
    env: {},
    sandbox: { describe: () => ({ id: "docker", kind: "docker" }) },
  } as unknown as RouterDeps;
  const context: AdapterContext = {
    userId: "owner",
    spaceId: "space",
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  };
  const catalog = fleetCatalog(deps);
  const target = {
    id: "connection",
    name: "Docker Desktop",
    kind: "docker" as const,
    connectionId: "connection",
    state: "unavailable" as const,
    capacity: unknownCapacity(),
    bots: [],
  };
  const list = vi.spyOn(catalog, "list").mockResolvedValue({
    targets: [target],
    hostLabel: "This computer",
    placement: { mode: "manual", preferredTargetId: "host", minimumFreeGb: 4 },
    bots: [],
    defaultTargetId: "host",
  } as never);
  const test = vi
    .fn()
    .mockRejectedValueOnce(new Error("engine-not-running"))
    .mockRejectedValueOnce(new Error("unexpected failure"))
    .mockResolvedValueOnce({});
  vi.spyOn(catalog.connections, "resolve").mockResolvedValue({ test } as never);
  const result = await testFleetTarget(deps, context, "connection");
  expect(FleetTestResultSchema.parse(result)).toMatchObject({
    ok: false,
    reason: "engine-not-running",
    targets: [target],
  });
  await expect(testFleetTarget(deps, context, "connection")).rejects.toThrow("unexpected failure");
  list.mockRejectedValueOnce(new Error("list failed"));
  await expect(testFleetTarget(deps, context, "connection")).rejects.toThrow("list failed");
});

it("probes a saved local socket through engineInfo when the provider has no test method", async () => {
  const deps = {
    prisma: {
      connection: {
        findFirstOrThrow: async () => ({
          metadata: { engine: "docker", socket: "unix:///fixture/docker.sock" },
        }),
      },
    },
    secrets: { load: vi.fn() },
    env: {},
    sandbox: { describe: () => ({ id: "docker", kind: "docker" }) },
  } as unknown as RouterDeps;
  const context: AdapterContext = {
    userId: "owner",
    spaceId: "space",
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  };
  const catalog = fleetCatalog(deps);
  vi.spyOn(catalog, "list").mockResolvedValue({
    targets: [
      {
        id: "saved",
        name: "Docker",
        kind: "docker",
        connectionId: "saved",
        state: "unavailable",
        capacity: unknownCapacity(),
        bots: [],
      },
    ],
  } as never);
  const engineInfo = vi.fn().mockRejectedValue(new Error("socket-missing"));
  vi.spyOn(catalog.connections, "resolve").mockResolvedValue({ engineInfo } as never);
  await expect(testFleetTarget(deps, context, "saved")).resolves.toMatchObject({
    ok: false,
    reason: "socket-missing",
  });
  expect(engineInfo).toHaveBeenCalledOnce();
});
