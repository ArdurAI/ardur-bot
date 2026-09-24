import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as AdapterModule from "@ardurbot/adapters";
import { EncryptedSecretStore } from "@ardurbot/adapters";
import type { Actor, MemoryBundle } from "@ardurbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtureStores = vi.hoisted(() => ({
  state: { status: "ready" },
  source: { version: 1, documents: [] } as MemoryBundle,
  target: { version: 1, documents: [] } as MemoryBundle,
  fetch: vi.fn(),
  writes: vi.fn(),
}));
vi.mock("@ardurbot/adapters", async (original) => {
  const actual = await original<typeof AdapterModule>();
  return {
    ...actual,
    configuredGitStore: async () => ({
      startSession: fixtureStores.fetch,
      syncState: async () => fixtureStores.state,
    }),
    selectDocumentStore: async (_tx: unknown, config: { documentStore?: string } | null) => ({
      exportBundle: async () =>
        structuredClone(
          config?.documentStore === "git" ? fixtureStores.target : fixtureStores.source,
        ),
      importBundle: async (bundle: MemoryBundle) => {
        fixtureStores.writes();
        fixtureStores.target = structuredClone(bundle);
      },
    }),
  };
});

import { changeGitMemoryLocation } from "./memory-git-location.js";

async function fixture() {
  const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "git-location-fixture-")));
  const secrets = new EncryptedSecretStore("fixture-encryption-material");
  const records = new Map<string, Record<string, unknown>>();
  const current: { value: Record<string, unknown> | null } = { value: null };
  const tx = {
    $queryRaw: async () => [],
    spaceMember: { findUnique: async () => ({ role: "owner" }) },
    user: { findUnique: async () => ({ name: "Fixture member" }) },
    bot: { findMany: async () => [] },
    spaceMemoryConfig: {
      findUnique: async () => current.value,
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          current.value = {
            ...(current.value ? { ...current.value, ...update } : create),
            updatedAt: new Date(),
            defaultMemoryScope: "isolated",
          };
          return current.value;
        },
      ),
    },
    secret: {
      create: async ({ data }: { data: Record<string, unknown> & { id: string } }) => {
        records.set(data.id, data);
        return data;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        [...records.values()].find((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ) ?? null,
    },
  };
  return {
    deps: {
      dataDir,
      secrets,
      prisma: {
        ...tx,
        $transaction: async (action: (tx: unknown) => Promise<unknown>) => action(tx),
      } as never,
    },
    tx,
    records,
    actor: { userId: "user", spaceId: "space", isDeploymentOwner: false } as Actor,
    input: {
      url: "https://github.com/fixture/memory.git",
      branch: "main",
      mode: "publish" as const,
      expectedGeneration: 0,
      credential: { kind: "token" as const, value: "fixture-value" },
    },
    dispose: () => rm(dataDir, { recursive: true, force: true }),
  };
}
afterEach(() => {
  vi.clearAllMocks();
  fixtureStores.state = { status: "ready" };
  fixtureStores.target = { version: 1, documents: [] };
});
describe("Git Settings preview and connection", () => {
  it("encrypts credentials, fetches before setup, and applies only the exact preview", async () => {
    const f = await fixture();
    try {
      const preview = await changeGitMemoryLocation(f.deps, f.actor, f.input);
      expect(fixtureStores.fetch).toHaveBeenCalledOnce();
      expect(f.tx.spaceMemoryConfig.upsert).not.toHaveBeenCalled();
      expect(fixtureStores.writes).not.toHaveBeenCalled();
      expect(JSON.stringify([...f.records.values()]).includes(f.input.credential.value)).toBe(
        false,
      );
      expect(JSON.stringify(preview).includes(f.input.credential.value)).toBe(false);
      const { credential: _credential, ...input } = f.input;
      await expect(
        changeGitMemoryLocation(f.deps, f.actor, {
          ...input,
          mode: "propose",
          connectionId: preview.connectionId,
          expectedHash: preview.hash,
        }),
      ).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
      const result = await changeGitMemoryLocation(f.deps, f.actor, {
        ...input,
        connectionId: preview.connectionId,
        expectedHash: preview.hash,
      });
      expect(result.config).toMatchObject({
        documentStore: "git",
        generation: 1,
        documentSettings: { host: "github.com", mode: "publish" },
      });
      expect(result.config?.documentSettings).not.toHaveProperty("credential");
      expect(fixtureStores.writes).toHaveBeenCalledOnce();
    } finally {
      await f.dispose();
    }
  });
  it("blocks a failed fetch and credentials reused for a different repository", async () => {
    const f = await fixture();
    try {
      fixtureStores.state = { status: "last-copy" };
      await expect(changeGitMemoryLocation(f.deps, f.actor, f.input)).rejects.toThrow(
        "Could not fetch",
      );
      expect(f.tx.spaceMemoryConfig.upsert).not.toHaveBeenCalled();
      fixtureStores.state = { status: "ready" };
      const preview = await changeGitMemoryLocation(f.deps, f.actor, f.input);
      const { credential: _credential, ...input } = f.input;
      await expect(
        changeGitMemoryLocation(f.deps, f.actor, {
          ...input,
          url: "https://github.com/fixture/other.git",
          connectionId: preview.connectionId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await f.dispose();
    }
  });
});
