import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { unknownCapacity } from "@ardurbot/contracts/fleet";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import { updateComputerConnection } from "./computer-settings.js";
import {
  cleanupFleetSecret,
  fleetCatalog,
  fleetConnectionDetails,
  reconcileFleetSecretCleanup,
  removeFleetTarget,
} from "./fleet.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

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
  let provisionalIntent: { hostSecretId: string; spaceId: string; userId: string } | null = null;
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
    fleetSecretCleanup: {
      create: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => {
        provisionalIntent = null;
        return { count: 1 };
      }),
    },
  };
  const prisma = {
    connection: { findFirstOrThrow: vi.fn(async () => row), findFirst: vi.fn(async () => null) },
    run: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => null) },
    fleetSecretCleanup: {
      create: vi.fn(async ({ data }) => {
        provisionalIntent = {
          hostSecretId: data.hostSecretId,
          spaceId: data.spaceId,
          userId: data.userId,
        };
        return provisionalIntent;
      }),
      findUnique: vi.fn(async () => provisionalIntent),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    secrets: {
      load: vi.fn(),
      put: vi.fn(async () => ({ id: "new-db-secret", ciphertext: "fixture" })),
    },
    env: {},
    sandbox: { describe: () => ({ id: "docker", kind: "docker" }) },
  } as unknown as RouterDeps;
  return { tx, prisma, deps };
}

describe("saved fleet connections", () => {
  it("keeps the cleanup intent until the host acknowledges deletion", async () => {
    const { deps } = fixture();
    let acknowledge!: (value: { ok: true }) => void;
    const hostReply = new Promise<{ ok: true }>((resolve) => {
      acknowledge = resolve;
    });
    deps.hostBridge = { fleetResult: vi.fn(() => hostReply) } as never;
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    try {
      const cleanup = cleanupFleetSecret(
        deps.prisma,
        deps.hostBridge,
        context,
        "afdf5a2e-09f0-42c9-917e-35c45f34db37",
      );
      expect(deps.prisma.fleetSecretCleanup.deleteMany).not.toHaveBeenCalled();
      acknowledge({ ok: true });
      await expect(cleanup).resolves.toBe(true);
      expect(deps.prisma.fleetSecretCleanup.deleteMany).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the cleanup intent when the host does not confirm deletion", async () => {
    const { deps } = fixture();
    deps.hostBridge = { fleetResult: vi.fn(async () => ({ ok: false })) } as never;
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    try {
      await expect(
        cleanupFleetSecret(
          deps.prisma,
          deps.hostBridge,
          context,
          "afdf5a2e-09f0-42c9-917e-35c45f34db37",
        ),
      ).resolves.toBe(false);
      expect(deps.prisma.fleetSecretCleanup.deleteMany).not.toHaveBeenCalled();
      expect(deps.prisma.fleetSecretCleanup.updateMany).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns the committed revision through the router when an SSH probe throws", async () => {
    const { deps, prisma, tx } = fixture();
    let current = row;
    vi.mocked(prisma.connection.findFirstOrThrow).mockImplementation(async () => current);
    tx.connection.findFirstOrThrow.mockImplementation(async () => current);
    tx.connection.update.mockImplementation(async ({ data }) => {
      current = {
        ...current,
        metadata: data.metadata as typeof metadata,
        updatedAt: new Date(current.updatedAt.getTime() + 1000),
      };
      return current;
    });
    const catalog = fleetCatalog(deps);
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error("SSH operation failed; test the connection in Computers."))
      .mockResolvedValueOnce({});
    vi.spyOn(catalog.connections, "resolve").mockResolvedValue({ test: probe } as never);
    vi.spyOn(catalog, "list").mockResolvedValue({
      targets: [
        {
          id: "saved",
          name: "Remote",
          kind: "ssh",
          connectionId: "saved",
          state: "unavailable",
          capacity: unknownCapacity(),
          bots: [],
        },
      ],
    } as never);
    const actor = {
      userId: context.userId,
      spaceId: context.spaceId,
      isDeploymentOwner: true,
    } as Actor;
    const handler = new RPCHandler(createRouter(deps));
    const save = async (user: string, revision: string) => {
      const { response } = await handler.handle(
        new Request("http://localhost/rpc/fleet/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: {
              connectionId: "saved",
              connection: {
                name: "Remote",
                settings: { engine: "ssh", ssh: { host: "computer.invalid", user } },
              },
              revision,
              confirmActive: false,
            },
          }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return { status: response.status, body: await response.json() };
    };
    const first = await save("wrong", row.updatedAt.toISOString());
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      json: expect.objectContaining({
        ok: false,
        reason: "not-reachable",
        revision: current.updatedAt.toISOString(),
      }),
    });
    expect(JSON.stringify(first.body)).not.toContain("SSH operation failed");
    const second = await save("corrected", current.updatedAt.toISOString());
    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      json: expect.objectContaining({ ok: true, revision: current.updatedAt.toISOString() }),
    });
    expect(tx.connection.update).toHaveBeenCalledTimes(2);
  });

  it("scopes details and update to the owner and space", async () => {
    const { prisma, tx, deps } = fixture();
    const details = await fleetConnectionDetails(deps, context, "saved");
    expect(details).toMatchObject({
      name: "Old",
      activeRuns: false,
      revision: row.updatedAt.toISOString(),
    });
    expect(prisma.connection.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "saved", spaceId: "space", userId: "owner", connectorId: "computer" },
    });
    await updateComputerConnection(
      deps,
      "saved",
      { name: "New", settings: metadata },
      row.updatedAt.toISOString(),
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
    await expect(
      updateComputerConnection(deps, "saved", next, row.updatedAt.toISOString(), false, context),
    ).rejects.toMatchObject({
      data: { code: "fleet-active-runs" },
    });
    expect(tx.connection.update).not.toHaveBeenCalled();
    await updateComputerConnection(deps, "saved", next, row.updatedAt.toISOString(), true, context);
    expect(tx.fleetAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "connection-updated" }),
    });
  });
  it("rejects a second editor's stale revision before restoring its old endpoint", async () => {
    const { deps, prisma, tx } = fixture();
    const loaded = await fleetConnectionDetails(deps, context, "saved");
    const changed = {
      ...row,
      metadata: { ...metadata, endpoint: "unix:///fixture/new.sock" },
      updatedAt: new Date(1),
    };
    vi.mocked(prisma.connection.findFirstOrThrow).mockResolvedValue(changed as never);
    tx.connection.findFirstOrThrow.mockResolvedValue(changed);
    await expect(
      updateComputerConnection(
        deps,
        "saved",
        { name: "Other", settings: metadata },
        loaded.revision,
        false,
        context,
      ),
    ).rejects.toThrow("This computer changed");
    expect(loaded.settings.endpoint).toBe(metadata.endpoint);
    expect(tx.connection.update).not.toHaveBeenCalled();
  });
  it("returns each committed revision for a corrected second save", async () => {
    const { deps, prisma, tx } = fixture();
    let current = row;
    vi.mocked(prisma.connection.findFirstOrThrow).mockImplementation(async () => current);
    tx.connection.findFirstOrThrow.mockImplementation(async () => current);
    tx.connection.update.mockImplementation(async ({ data }) => {
      current = {
        ...current,
        metadata: data.metadata as typeof metadata,
        updatedAt: new Date(current.updatedAt.getTime() + 1000),
      };
      return current;
    });
    const failedProbeEndpoint = ComputerConnectionSettingsSchema.parse({
      engine: "docker",
      endpoint: "unix:///fixture/missing.sock",
    });
    const first = await updateComputerConnection(
      deps,
      "saved",
      { name: "Old", settings: failedProbeEndpoint },
      row.updatedAt.toISOString(),
      false,
      context,
    );
    expect(first.revision).toBe(current.updatedAt.toISOString());
    const corrected = await updateComputerConnection(
      deps,
      "saved",
      {
        name: "Old",
        settings: ComputerConnectionSettingsSchema.parse({
          engine: "docker",
          endpoint: "unix:///fixture/correct.sock",
        }),
      },
      first.revision,
      false,
      context,
    );
    expect(corrected.revision).toBe(current.updatedAt.toISOString());
    expect(tx.connection.update).toHaveBeenCalledTimes(2);
  });
  it.each(["leased", "waiting_takeover"])(
    "includes %s in details and the change confirmation guard",
    async () => {
      const { deps, prisma } = fixture();
      vi.mocked(prisma.run.findFirst).mockResolvedValue({ id: "run" } as never);
      const details = await fleetConnectionDetails(deps, context, "saved");
      expect(details.activeRuns).toBe(true);
      expect(prisma.run.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: expect.arrayContaining(["leased", "waiting_takeover"]) },
          }),
        }),
      );
      await expect(
        updateComputerConnection(
          deps,
          "saved",
          {
            name: "Old",
            settings: ComputerConnectionSettingsSchema.parse({
              engine: "docker",
              endpoint: "unix:///fixture/other.sock",
            }),
          },
          row.updatedAt.toISOString(),
          false,
          context,
        ),
      ).rejects.toThrow("Runs are active");
    },
  );
  it("records retryable cleanup for an imported credential when the update conflicts", async () => {
    const { deps, tx } = fixture();
    let hostSecretId = "";
    tx.connection.findFirstOrThrow.mockResolvedValue({ ...row, updatedAt: new Date(1) });
    const fleetResult = vi.fn(async (op: { op: string; secretId?: string }) => {
      if (op.op === "computer.remote.secret") {
        hostSecretId = op.secretId!;
        return { id: hostSecretId };
      }
      return { ok: true };
    });
    deps.hostBridge = { fleetResult } as never;
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    try {
      await expect(
        updateComputerConnection(
          deps,
          "saved",
          {
            name: "Old",
            settings: ComputerConnectionSettingsSchema.parse({
              engine: "docker",
              endpoint: "tcp://fixture.example:2376",
            }),
            tlsPaths: { ca: "/fixture/ca", cert: "/fixture/cert", key: "/fixture/key" },
          },
          row.updatedAt.toISOString(),
          false,
          context,
        ),
      ).rejects.toThrow("This computer changed");
      expect(deps.prisma.fleetSecretCleanup.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ hostSecretId }),
      });
      expect(deps.prisma.fleetSecretCleanup.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ hostSecretId }) }),
      );
      expect(fleetResult).not.toHaveBeenCalledWith(
        { op: "computer.remote.secret.delete", secretId: hostSecretId },
        context,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("schedules cleanup for a Kubernetes credential imported before a failed transaction", async () => {
    const { deps, tx } = fixture();
    let hostSecretId = "";
    tx.connection.findFirstOrThrow.mockResolvedValue({ ...row, updatedAt: new Date(1) });
    const fleetResult = vi.fn(async (op: { op: string; secretId?: string }) => {
      if (op.op === "computer.remote.secret") {
        hostSecretId = op.secretId!;
        return { id: hostSecretId };
      }
      return { ok: true };
    });
    deps.hostBridge = { fleetResult } as never;
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    const kubeconfig = JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "fixture", cluster: { server: "https://fixture.invalid" } }],
      users: [{ name: "fixture", user: { token: "fake" } }],
      contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
      "current-context": "fixture",
    });
    try {
      await expect(
        updateComputerConnection(
          deps,
          "saved",
          {
            name: "Old",
            settings: ComputerConnectionSettingsSchema.parse({
              engine: "kubernetes",
              context: "fixture",
            }),
            kubeconfig,
          },
          row.updatedAt.toISOString(),
          false,
          context,
        ),
      ).rejects.toThrow("This computer changed");
      expect(deps.prisma.fleetSecretCleanup.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ hostSecretId }),
      });
      expect(deps.prisma.fleetSecretCleanup.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ hostSecretId }) }),
      );
      expect(fleetResult).not.toHaveBeenCalledWith(
        { op: "computer.remote.secret.delete", secretId: hostSecretId },
        context,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("keeps a retryable intent if compensation loses its host response", async () => {
    const { deps } = fixture();
    let hostSecretId = "";
    const fleetResult = vi.fn(async (op: { op: string; secretId?: string }) => {
      if (op.op === "computer.remote.secret") {
        hostSecretId = op.secretId!;
        return { id: hostSecretId };
      }
      throw new Error("host disconnected");
    });
    deps.hostBridge = { fleetResult } as never;
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    try {
      await expect(
        updateComputerConnection(
          deps,
          "saved",
          {
            name: "Old",
            settings: ComputerConnectionSettingsSchema.parse({
              engine: "docker",
              socket: "relative.sock",
            }),
            tlsPaths: { ca: "/fixture/ca", cert: "/fixture/cert", key: "/fixture/key" },
          },
          row.updatedAt.toISOString(),
          false,
          context,
        ),
      ).rejects.toThrow("Choose a local engine socket");
      expect(deps.prisma.fleetSecretCleanup.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ hostSecretId }),
      });
      expect(deps.prisma.fleetSecretCleanup.deleteMany).not.toHaveBeenCalled();
      expect(deps.prisma.fleetSecretCleanup.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ hostSecretId }),
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("removes the temporary cleanup intent when the imported credential commits", async () => {
    const { deps, tx } = fixture();
    let hostSecretId = "";
    const fleetResult = vi.fn(async (op: { secretId?: string }) => {
      hostSecretId = op.secretId!;
      return { id: hostSecretId };
    });
    deps.hostBridge = { fleetResult } as never;
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    try {
      await updateComputerConnection(
        deps,
        "saved",
        {
          name: "Old",
          settings: ComputerConnectionSettingsSchema.parse({
            engine: "docker",
            endpoint: "tcp://fixture.example:2376",
          }),
          tlsPaths: { ca: "/fixture/ca", cert: "/fixture/cert", key: "/fixture/key" },
        },
        row.updatedAt.toISOString(),
        false,
        context,
      );
      expect(tx.fleetSecretCleanup.deleteMany).toHaveBeenCalledWith({
        where: { hostSecretId: { in: [hostSecretId] } },
      });
      expect(fleetResult).not.toHaveBeenCalledWith(
        { op: "computer.remote.secret.delete", secretId: hostSecretId },
        context,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retains an imported credential when the connection commits but its response is lost", async () => {
    const { deps, tx } = fixture();
    let committed = false;
    let importedId = "";
    const fleetResult = vi.fn(async (op: { op: string; secretId?: string }) => {
      if (op.op === "computer.remote.secret") {
        importedId = op.secretId ?? "afdf5a2e-09f0-42c9-917e-35c45f34db37";
        return { id: importedId };
      }
      return { ok: true };
    });
    deps.hostBridge = { fleetResult } as never;
    deps.prisma.$transaction = (async (work: (value: typeof tx) => Promise<unknown>) => {
      await work(tx);
      committed = true;
      throw new Error("commit response lost");
    }) as never;
    vi.mocked(deps.prisma.connection.findFirstOrThrow).mockImplementation(async () =>
      committed
        ? ({ ...row, metadata: { ...metadata, hostSecretId: importedId } } as never)
        : (row as never),
    );
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    try {
      await expect(
        updateComputerConnection(
          deps,
          "saved",
          {
            name: "Old",
            settings: ComputerConnectionSettingsSchema.parse({
              engine: "docker",
              endpoint: "tcp://fixture.example:2376",
            }),
            tlsPaths: { ca: "/fixture/ca", cert: "/fixture/cert", key: "/fixture/key" },
          },
          row.updatedAt.toISOString(),
          false,
          context,
        ),
      ).rejects.toThrow("commit response lost");
      expect(committed).toBe(true);
      expect(importedId).toMatch(/^[a-f0-9-]{36}$/);
      expect(fleetResult).not.toHaveBeenCalledWith(
        { op: "computer.remote.secret.delete", secretId: importedId },
        context,
      );
      expect(deps.prisma.fleetSecretCleanup.updateMany).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reconciles an import whose host write succeeded but its response was lost", async () => {
    const { deps } = fixture();
    let intent: { hostSecretId: string; spaceId: string; userId: string } | undefined;
    const create = vi.mocked(deps.prisma.fleetSecretCleanup.create);
    create.mockImplementation(async ({ data }) => {
      intent = { hostSecretId: data.hostSecretId, spaceId: data.spaceId, userId: data.userId };
      return intent as never;
    });
    vi.mocked(deps.prisma.fleetSecretCleanup.findUnique).mockImplementation(
      async () => (intent as never) ?? null,
    );
    vi.mocked(deps.prisma.fleetSecretCleanup.findMany).mockImplementation(async () =>
      intent ? ([intent] as never) : [],
    );
    vi.mocked(deps.prisma.fleetSecretCleanup.deleteMany).mockImplementation(async () => {
      intent = undefined;
      return { count: 1 };
    });
    let hostCopy = "";
    const fleetResult = vi.fn(async (op: { op: string; secretId?: string }) => {
      if (op.op === "computer.remote.secret") {
        expect(intent).toBeDefined();
        expect(op.secretId).toMatch(/^[a-f0-9-]{36}$/);
        expect(intent?.hostSecretId).toBe(op.secretId);
        hostCopy = op.secretId!;
        throw new Error("import response lost");
      }
      if (op.op === "computer.remote.secret.delete") hostCopy = "";
      return { ok: true };
    });
    deps.hostBridge = { fleetResult } as never;
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    try {
      await expect(
        updateComputerConnection(
          deps,
          "saved",
          {
            name: "Old",
            settings: ComputerConnectionSettingsSchema.parse({
              engine: "docker",
              endpoint: "tcp://fixture.example:2376",
            }),
            tlsPaths: { ca: "/fixture/ca", cert: "/fixture/cert", key: "/fixture/key" },
          },
          row.updatedAt.toISOString(),
          false,
          context,
        ),
      ).rejects.toThrow("import response lost");
      expect(hostCopy).toMatch(/^[a-f0-9-]{36}$/);
      expect(intent?.hostSecretId).toBe(hostCopy);
      await reconcileFleetSecretCleanup(deps.prisma, deps.hostBridge);
      expect(hostCopy).toBe("");
      expect(intent).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses removal when bots are pinned and lists their names", async () => {
    const { deps, tx } = fixture(["First\nBot", "Second", "Third"]);
    await expect(removeFleetTarget(deps, context, "saved")).rejects.toMatchObject({
      data: { code: "fleet-pinned-bots", botNames: ["First\nBot", "Second", "Third"], count: 3 },
    });
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
  it("keeps a credential referenced by a connection when reconciling a stale intent", async () => {
    const { deps } = fixture();
    const hostSecretId = "afdf5a2e-09f0-42c9-917e-35c45f34db37";
    vi.mocked(deps.prisma.fleetSecretCleanup.findMany).mockResolvedValue([
      { hostSecretId, spaceId: "space", userId: "owner" },
    ] as never);
    vi.mocked(deps.prisma.connection.findFirst).mockResolvedValue({ id: "saved" } as never);
    const fleetResult = vi.fn();
    deps.hostBridge = { fleetResult } as never;
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    try {
      await reconcileFleetSecretCleanup(deps.prisma, deps.hostBridge);
      expect(fleetResult).not.toHaveBeenCalled();
      expect(deps.prisma.fleetSecretCleanup.deleteMany).toHaveBeenCalledWith({
        where: { hostSecretId },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
