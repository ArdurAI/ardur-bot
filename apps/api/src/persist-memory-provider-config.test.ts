import { MemoryProviderDeploymentOwnerRequiredError } from "@ardurbot/adapters";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import {
  disconnectMemoryProvider,
  persistMemoryProviderConfig,
  testMemoryProviderConnection,
  updateMemoryProviderDefaultScope,
} from "./memory-provider-config.js";

const actor = {
  userId: "user-1",
  spaceId: "ws-1",
  email: "a@b.com",
  isDeploymentOwner: false,
};
const deploymentOwner = { ...actor, isDeploymentOwner: true };

function makeDeps(
  overrides: {
    existing?: { id: string; secretId: string } | null;
    upsertResult?: {
      provider: string;
      settings: Record<string, string>;
      defaultMemoryScope: string;
      updatedAt: Date;
    };
    updateResult?: {
      provider: string;
      settings: Record<string, string>;
      defaultMemoryScope: string;
      updatedAt: Date;
    };
    spaceOwner?: boolean;
    memberRole?: string;
  } = {},
) {
  const secretCreate = vi.fn().mockResolvedValue({ id: "secret-new" });
  const secretDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const findUnique = vi.fn().mockResolvedValue(overrides.existing ?? null);
  const upsert = vi.fn().mockResolvedValue(
    overrides.upsertResult ?? {
      provider: "supermemory",
      settings: { mode: "cloud", baseUrl: "https://api.supermemory.ai" },
      defaultMemoryScope: "isolated",
      updatedAt: new Date("2026-08-19T00:00:00.000Z"),
    },
  );
  const update = vi.fn().mockResolvedValue(
    overrides.updateResult ?? {
      provider: "supermemory",
      settings: { mode: "cloud", baseUrl: "https://api.supermemory.ai" },
      defaultMemoryScope: "shared",
      updatedAt: new Date("2026-08-20T00:00:00.000Z"),
    },
  );
  const deleteConfig = vi.fn().mockResolvedValue({ id: "cfg-1" });
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    bot: { findMany: vi.fn().mockResolvedValue([]) },
    chatGroup: { findMany: vi.fn().mockResolvedValue([]) },
    memoryDocument: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    spaceMember: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          overrides.spaceOwner === false ? null : { role: overrides.memberRole ?? "owner" },
        ),
    },
    spaceMemoryConfig: { findUnique, update, upsert, delete: deleteConfig },
    secret: { create: secretCreate, deleteMany: secretDeleteMany },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: { put: vi.fn().mockResolvedValue({ id: "secret-new", ciphertext: "cipher" }) },
  };
  return {
    deps,
    secretCreate,
    secretDeleteMany,
    findUnique,
    upsert,
    update,
    deleteConfig,
    transaction: prisma.$transaction,
  };
}

function connectionInput(mode: "cloud" | "local", baseUrl?: string) {
  return {
    provider: "supermemory",
    settings: { mode, ...(baseUrl ? { baseUrl } : {}) },
    credentials: { apiKey: "sm_test_key_12345" },
    defaultMemoryScope: "isolated" as const,
  };
}

describe("persistMemoryProviderConfig", () => {
  it.each(["mem0", "mem0-oss", "graphiti"])(
    "tests %s before saving and keeps credentials out of the response and settings",
    async (provider) => {
      const { deps, upsert } = makeDeps();
      const input = {
        provider,
        settings: { baseUrl: "https://memory.example.test" },
        credentials: { apiKey: "fixture-placeholder" },
        defaultMemoryScope: "isolated" as const,
      };
      const prepareConnection = vi.fn(async () => ({
        provider,
        settings: input.settings,
        credentials: input.credentials,
      }));
      const preparedDeps = {
        ...deps,
        classifySettings: async () => input.settings,
        prepareConnection,
      };
      expect(await testMemoryProviderConnection(preparedDeps, actor, input)).toEqual({ ok: true });
      expect(deps.secrets.put).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      await persistMemoryProviderConfig(preparedDeps, actor, input);
      expect(prepareConnection).toHaveBeenCalledTimes(2);
      expect(deps.secrets.put).toHaveBeenCalledWith(
        JSON.stringify(input.credentials),
        expect.anything(),
      );
      expect(upsert.mock.calls[0]![0].create.settings).toEqual(input.settings);
    },
  );
  it.each(["mem0-oss", "graphiti"])(
    "gates private %s connection tests before a credentialed probe",
    async (provider) => {
      const { deps } = makeDeps();
      const prepareConnection = vi.fn();
      await expect(
        testMemoryProviderConnection({ ...deps, prepareConnection }, actor, {
          provider,
          settings: { baseUrl: "http://127.0.0.1:8000" },
          credentials: {},
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(prepareConnection).not.toHaveBeenCalled();
    },
  );
  it("retargets every space revision without revising documents and queues each authorized owner", async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.prisma.memoryDocument.findMany).mockImplementation(async (input) =>
      input?.select
        ? ([
            { id: "private-doc", revision: 4, userId: "member", scope: "user" },
            { id: "shared-doc", revision: 2, userId: "past-member", scope: "space-shared" },
          ] as never)
        : [],
    );
    const enqueue = vi.fn(async () => undefined);
    await persistMemoryProviderConfig(
      {
        ...deps,
        jobs: { enqueue },
        classifySettings: async () => ({}),
        prepareConnection: async () => ({
          provider: "mem0",
          settings: { filterVersion: "platform-v3" },
          credentials: {},
        }),
      },
      actor,
      { provider: "mem0", settings: {}, credentials: {}, defaultMemoryScope: "isolated" },
    );
    expect(deps.prisma.memoryDocument.updateMany).toHaveBeenCalledWith({
      where: { spaceId: actor.spaceId },
      data: {
        deliveryStatus: "pending",
        deliveryProvider: "mem0",
        deliveryGeneration: 1,
        deliveryReceipt: null,
        deliveryRetryAt: null,
      },
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]![0]).toMatchObject({
      payload: { documentId: "private-doc", revision: 4, userId: "member" },
    });
    expect(enqueue.mock.calls[1]![0]).toMatchObject({
      payload: { documentId: "shared-doc", revision: 2, userId: actor.userId },
    });
  });
  it("rejects unknown providers as bad requests without probing or writing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, transaction } = makeDeps();
    try {
      await expect(
        persistMemoryProviderConfig(deps, actor, {
          ...connectionInput("cloud"),
          provider: "unknown-provider",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["#", "?action=delete", "?"])(
    "rejects ambiguous local URLs even for the deployment owner: %s",
    async (suffix) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { deps, transaction } = makeDeps();
      try {
        await expect(
          persistMemoryProviderConfig(
            deps,
            deploymentOwner,
            connectionInput("local", `http://127.0.0.1:8123/internal-action${suffix}`),
          ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["http://127.0.0.1:8123/internal-action#", "http://localhost:6767"])(
    "rejects ordinary Space owners before any local probe or write: %s",
    async (baseUrl) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("[]"));
      vi.stubGlobal("fetch", fetchMock);
      const { deps, transaction } = makeDeps();
      try {
        await expect(
          persistMemoryProviderConfig(deps, actor, connectionInput("local", baseUrl)),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(deps.secrets.put).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("still requires Space ownership for a deployment owner", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, transaction } = makeDeps({ spaceOwner: false });
    try {
      await expect(
        persistMemoryProviderConfig(
          deps,
          deploymentOwner,
          connectionInput("local", "http://localhost:6767"),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects non-owners before probing or writing Space configuration", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, upsert } = makeDeps({ spaceOwner: false });

    await expect(
      persistMemoryProviderConfig(deps, actor, connectionInput("cloud")),
    ).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects local mode without a baseUrl, without touching the database", async () => {
    const { deps, upsert } = makeDeps();
    await expect(
      persistMemoryProviderConfig(deps, deploymentOwner, connectionInput("local")),
    ).rejects.toThrow(/baseUrl/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback baseUrl in local mode without probing or touching the database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, upsert } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        deps,
        deploymentOwner,
        connectionInput("local", "http://169.254.169.254/latest/meta-data/"),
      ),
    ).rejects.toThrow(/loopback/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("probes before persisting, and rejects (without writing) when the probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const { deps, upsert } = makeDeps();
    await expect(
      persistMemoryProviderConfig(deps, deploymentOwner, {
        ...connectionInput("local", "http://localhost:6767"),
        credentials: { apiKey: "sm_bad_key" },
      }),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("accepts a bracketed IPv6 loopback base URL in local mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { deps, upsert } = makeDeps();

    await persistMemoryProviderConfig(
      deps,
      deploymentOwner,
      connectionInput("local", "http://[::1]:6767"),
    );

    expect(fetchMock.mock.calls[0]![0]).toBe("http://[::1]:6767/v3/container-tags/list");
    expect(upsert).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("connects cloud mode, defaulting the base URL, and returns the serialized config", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const { deps, upsert, transaction } = makeDeps();
    const result = await persistMemoryProviderConfig(deps, actor, connectionInput("cloud"));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws-1" },
        create: expect.objectContaining({
          provider: "supermemory",
          settings: { mode: "cloud", baseUrl: "https://api.supermemory.ai" },
        }),
      }),
    );
    expect(result).toMatchObject({
      provider: "supermemory",
      settings: { mode: "cloud", baseUrl: "https://api.supermemory.ai" },
      defaultMemoryScope: "isolated",
      updatedAt: "2026-08-19T00:00:00.000Z",
    });
    expect(transaction).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("deletes the old secret when replacing an existing config with a new key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const { deps, secretDeleteMany } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-old" },
    });
    await persistMemoryProviderConfig(deps, actor, {
      ...connectionInput("cloud"),
      credentials: { apiKey: "sm_new_key_12345" },
    });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-old" } });
    vi.unstubAllGlobals();
  });

  it("rejects non-deployment-owners for public-looking Serenity hostnames that resolve private, without probing", async () => {
    const prepareConnection = vi.fn();
    const { deps, transaction } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        {
          ...deps,
          classifySettings: async () => ({
            endpoint: "https://serenity.example.test/mcp",
            endpointTrust: "private",
          }),
          prepareConnection,
        },
        actor,
        {
          provider: "serenity",
          settings: { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
          credentials: { token: "serenity_test_token" },
          defaultMemoryScope: "isolated",
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prepareConnection).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects non-owners when prepare reclassifies a hostname as private before probing", async () => {
    const prepareConnection = vi.fn(async () => {
      throw new MemoryProviderDeploymentOwnerRequiredError();
    });
    const { deps, transaction } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        {
          ...deps,
          classifySettings: async () => ({
            endpoint: "https://serenity.example.test/mcp",
          }),
          prepareConnection,
        },
        actor,
        {
          provider: "serenity",
          settings: { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
          credentials: { token: "serenity_test_token" },
          defaultMemoryScope: "isolated",
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prepareConnection).toHaveBeenCalledWith(
      expect.objectContaining({ allowPrivateEndpoint: false }),
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("disconnectMemoryProvider", () => {
  it("rejects non-owners before opening a transaction", async () => {
    const { deps, transaction, secretDeleteMany } = makeDeps({ spaceOwner: false });

    await expect(disconnectMemoryProvider(deps, actor)).rejects.toThrow();

    expect(transaction).not.toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
  });

  it("disconnects an existing provider and removes its secret in the same transaction", async () => {
    const { deps, transaction, update, secretDeleteMany } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-old" },
    });

    await expect(disconnectMemoryProvider(deps, actor)).resolves.toEqual({ ok: true });

    expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "cfg-1" },
      data: { provider: "builtin", settings: {}, secretId: null, generation: { increment: 1 } },
    });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-old" } });
  });

  it("leaves secrets untouched when no provider is configured", async () => {
    const { deps, deleteConfig, secretDeleteMany } = makeDeps();

    await expect(disconnectMemoryProvider(deps, actor)).resolves.toEqual({ ok: true });

    expect(deleteConfig).not.toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
  });
});

describe("updateMemoryProviderDefaultScope", () => {
  it("accepts owners with additional Better Auth roles", async () => {
    const { deps, update } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-existing" },
      memberRole: "owner,admin",
    });

    await updateMemoryProviderDefaultScope(deps, actor, "shared");

    expect(update).toHaveBeenCalled();
  });

  it("updates only the generic scope setting and retains the provider secret", async () => {
    const { deps, update, secretCreate, secretDeleteMany } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-existing" },
    });

    const result = await updateMemoryProviderDefaultScope(deps, actor, "shared");

    expect(update).toHaveBeenCalledWith({
      where: { id: "cfg-1" },
      data: { defaultMemoryScope: "shared" },
    });
    expect(secretCreate).not.toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
    expect(result.defaultMemoryScope).toBe("shared");
  });

  it("rejects non-owners without updating provider configuration", async () => {
    const { deps, update } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-existing" },
      spaceOwner: false,
    });

    await expect(updateMemoryProviderDefaultScope(deps, actor, "shared")).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});
