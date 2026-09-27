import type { AdapterContext } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { updateComputerConnection } from "./computer-settings.js";
import { fleetConnectionDetails, reconcileFleetSecretCleanup, removeFleetTarget } from "./fleet.js";
import type { RouterDeps } from "./router.js";

const context: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  operationId: "fleet-test",
  traceId: "fleet-test",
  signal: new AbortController().signal,
};
const metadata = ComputerConnectionSettingsSchema.parse({
  engine: "docker",
  endpoint: "unix:///fixture/docker.sock",
});
const row = {
  id: "saved",
  spaceId: "space",
  userId: "owner",
  connectorId: "computer",
  displayName: "Old",
  metadata,
  secretId: "db-secret",
  updatedAt: new Date(0),
};

function fixture(pinned: string[] = []) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "saved" }]),
    connection: {
      findFirstOrThrow: vi.fn(async () => row),
      update: vi.fn(async () => row),
      delete: vi.fn(async () => row),
    },
    bot: { findMany: vi.fn(async () => pinned.map((name) => ({ name }))) },
    computer: {
      findMany: vi.fn(async () => [{ id: "computer" }]),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    computerAdmission: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    space: {
      findUniqueOrThrow: vi.fn(async () => ({
        placement: { mode: "manual", preferredTargetId: "saved", minimumFreeGb: 4 },
      })),
      update: vi.fn(async () => ({})),
    },
    secret: { create: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 1 })) },
    fleetAudit: { create: vi.fn(async () => ({})) },
    fleetSecretCleanup: { create: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) },
  };
  const prisma = {
    connection: { findFirstOrThrow: vi.fn(async () => row) },
    run: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => null) },
    fleetSecretCleanup: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    secrets: { load: vi.fn() },
    env: {},
    sandbox: { describe: () => ({ id: "docker", kind: "docker" }) },
  } as unknown as RouterDeps;
  return { tx, prisma, deps };
}

describe("saved fleet connections", () => {
  it("scopes details and update to the owner and space", async () => {
    const { prisma, tx, deps } = fixture();
    const details = await fleetConnectionDetails(deps, context, "saved");
    expect(details).toMatchObject({ name: "Old", activeRuns: false });
    expect(prisma.connection.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "saved", spaceId: "space", userId: "owner", connectorId: "computer" },
    });
    await updateComputerConnection(
      deps,
      "saved",
      { name: "New", settings: metadata },
      false,
      context,
    );
    expect(tx.connection.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ displayName: "New" }) }),
    );
    expect(tx.fleetAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "renamed" }),
    });
  });

  it("requires confirmation for connection changes with active runs", async () => {
    const { prisma, tx, deps } = fixture();
    vi.mocked(prisma.run.findFirst).mockResolvedValue({ id: "run" } as never);
    const next = {
      name: "New",
      settings: ComputerConnectionSettingsSchema.parse({
        engine: "docker",
        endpoint: "unix:///fixture/new.sock",
      }),
    };
    await expect(updateComputerConnection(deps, "saved", next, false, context)).rejects.toThrow(
      "Runs are active",
    );
    expect(tx.connection.update).not.toHaveBeenCalled();
    await updateComputerConnection(deps, "saved", next, true, context);
    expect(tx.fleetAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "connection-updated" }),
    });
  });

  it("refuses removal when bots are pinned and lists their names", async () => {
    const { deps, tx } = fixture(["First", "Second", "Third"]);
    await expect(removeFleetTarget(deps, context, "saved")).rejects.toThrow(
      "3 bots run on this computer: First, Second, Third. Move them first.",
    );
    expect(tx.connection.delete).not.toHaveBeenCalled();
    expect(tx.secret.deleteMany).not.toHaveBeenCalled();
  });

  it("removes unpinned records, credentials, and writes a content-free audit", async () => {
    const { deps, tx } = fixture();
    await expect(removeFleetTarget(deps, context, "saved")).resolves.toEqual({ ok: true });
    expect(tx.computerAdmission.deleteMany).toHaveBeenCalled();
    expect(tx.computer.deleteMany).toHaveBeenCalled();
    expect(tx.connection.delete).toHaveBeenCalledWith({ where: { id: "saved" } });
    expect(tx.secret.deleteMany).toHaveBeenCalledWith({
      where: { id: "db-secret", spaceId: "space", userId: "owner" },
    });
    expect(tx.fleetAudit.create).toHaveBeenCalledWith({
      data: { spaceId: "space", userId: "owner", connectionId: "saved", action: "removed" },
    });
  });
  it("deletes the host credential referenced by a removed connection", async () => {
    const { deps, tx } = fixture();
    const secretId = "afdf5a2e-09f0-42c9-917e-35c45f34db37";
    tx.connection.findFirstOrThrow.mockResolvedValue({
      ...row,
      metadata: { ...metadata, hostSecretId: secretId },
    });
    const fleetResult = vi.fn(async () => ({ ok: true }));
    deps.hostBridge = { fleetResult } as never;
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    try {
      await removeFleetTarget(deps, context, "saved");
      expect(fleetResult).toHaveBeenCalledWith(
        { op: "computer.remote.secret.delete", secretId },
        context,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("commits removal and cleanup intent before deleting a host credential", async () => {
    const { deps, tx } = fixture();
    const secretId = "afdf5a2e-09f0-42c9-917e-35c45f34db37";
    tx.connection.findFirstOrThrow.mockResolvedValue({
      ...row,
      metadata: { ...metadata, hostSecretId: secretId },
    });
    let committed = false;
    deps.prisma.$transaction = (async (work: (value: typeof tx) => Promise<unknown>) => {
      const result = await work(tx);
      committed = true;
      return result;
    }) as never;
    const fleetResult = vi.fn(async () => {
      expect(committed).toBe(true);
      throw new Error("host disconnected after deletion");
    });
    deps.hostBridge = { fleetResult } as never;
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    try {
      await expect(removeFleetTarget(deps, context, "saved")).resolves.toEqual({ ok: true });
      expect(tx.fleetSecretCleanup.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ hostSecretId: secretId }),
      });
      expect(deps.prisma.fleetSecretCleanup.deleteMany).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("does not delete the host credential when the removal transaction rolls back", async () => {
    const { deps, tx } = fixture();
    tx.connection.findFirstOrThrow.mockResolvedValue({
      ...row,
      metadata: { ...metadata, hostSecretId: "afdf5a2e-09f0-42c9-917e-35c45f34db37" },
    });
    deps.prisma.$transaction = (async (work: (value: typeof tx) => Promise<unknown>) => {
      await work(tx);
      throw new Error("commit failed");
    }) as never;
    const fleetResult = vi.fn(async () => ({ ok: true }));
    deps.hostBridge = { fleetResult } as never;
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    try {
      await expect(removeFleetTarget(deps, context, "saved")).rejects.toThrow("commit failed");
      expect(fleetResult).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("retries a committed credential cleanup after the host reconnects", async () => {
    const { deps } = fixture();
    const hostSecretId = "afdf5a2e-09f0-42c9-917e-35c45f34db37";
    vi.mocked(deps.prisma.fleetSecretCleanup.findMany).mockResolvedValue([
      { hostSecretId, spaceId: "space", userId: "owner" },
    ] as never);
    const fleetResult = vi.fn(async () => ({ ok: true }));
    deps.hostBridge = { fleetResult } as never;
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    try {
      await reconcileFleetSecretCleanup(deps.prisma, deps.hostBridge);
      expect(fleetResult).toHaveBeenCalledWith(
        { op: "computer.remote.secret.delete", secretId: hostSecretId },
        expect.objectContaining({ spaceId: "space", userId: "owner" }),
      );
      expect(deps.prisma.fleetSecretCleanup.deleteMany).toHaveBeenCalledWith({
        where: { hostSecretId },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
