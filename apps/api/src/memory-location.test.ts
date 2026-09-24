import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { selectDocumentStore } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { PostgresDocumentStore } from "@ardurbot/memory";
import { memoryTestAccess, memoryTestCommit } from "@ardurbot/testkit/memory-conformance";
import { memoryDatabaseFake } from "@ardurbot/testkit/memory-fakes";
import { describe, expect, it, vi } from "vitest";
import { changeMemoryLocation } from "./memory-location.js";

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "memory-migration-fixture-")));
  const folder = path.join(root, "vault");
  await mkdir(folder);
  const database = memoryDatabaseFake();
  let config: {
    id: string;
    spaceId: string;
    userId: string;
    provider: string;
    settings: object;
    secretId: null;
    generation: number;
    documentStore: string;
    documentSettings: object;
    defaultMemoryScope: string;
    updatedAt: Date;
  } | null = null;
  const tx = Object.assign(database.tx, {
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
    spaceMember: { findUnique: vi.fn(async () => ({ role: "owner" })) },
    bot: { findMany: vi.fn(async () => []) },
    spaceMemoryConfig: {
      findUnique: async () => config,
      findFirst: async () => null,
      upsert: async ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        config = {
          id: "config",
          spaceId: "space-a",
          userId: "user-a",
          provider: "builtin",
          settings: {},
          secretId: null,
          documentStore: "postgres",
          documentSettings: {},
          defaultMemoryScope: "isolated",
          updatedAt: new Date(),
          ...config,
          ...(config ? update : create),
          generation: config ? config.generation + 1 : 1,
        } as NonNullable<typeof config>;
        return config;
      },
    },
  });
  const prisma = {
    ...tx,
    $transaction: async (action: (value: typeof tx) => Promise<unknown>) => action(tx),
  } as unknown as PrismaClient;
  const actor: Actor = {
    spaceId: "space-a",
    userId: "user-a",
    email: "owner@example.test",
    isDeploymentOwner: true,
  };
  const access = memoryTestAccess();
  const store = new PostgresDocumentStore(tx);
  const doc = await store.commit(memoryTestCommit(access), access);
  await store.commit(
    { ...memoryTestCommit(access), id: doc.id, expectedRevision: 1, content: "Second revision" },
    access,
  );
  return {
    root,
    folder,
    database,
    tx,
    config: () => config,
    actor,
    access,
    doc,
    deps: { prisma, dataDir: path.join(root, "data") },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
describe("atomic memory location migration", () => {
  it("retains the source if the configuration switch fails after copying and can retry safely", async () => {
    const f = await fixture();
    try {
      const input = { location: "obsidian" as const, folder: f.folder, expectedGeneration: 0 };
      const preview = await changeMemoryLocation(f.deps, f.actor, input);
      const upsert = f.tx.spaceMemoryConfig.upsert;
      f.tx.spaceMemoryConfig.upsert = async () => {
        throw new Error("Injected configuration failure");
      };
      await expect(
        changeMemoryLocation(f.deps, f.actor, { ...input, expectedHash: preview.hash }),
      ).rejects.toThrow("Injected configuration failure");
      expect(f.config()).toBeNull();
      expect(f.database.documents.get(f.doc.id)?.content).toBe("Second revision");
      expect(await readdir(f.folder)).toContain(".ardur-memory.json");
      f.tx.spaceMemoryConfig.upsert = upsert;
      expect(
        await changeMemoryLocation(f.deps, f.actor, { ...input, expectedHash: preview.hash }),
      ).toMatchObject({ generation: 1 });
    } finally {
      await f.dispose();
    }
  });
  it("previews without writing, verifies history and hashes, retains the source and returns from the vault", async () => {
    const f = await fixture();
    try {
      const input = { location: "obsidian" as const, folder: f.folder, expectedGeneration: 0 };
      const preview = await changeMemoryLocation(f.deps, f.actor, input);
      expect(preview).toMatchObject({ documents: 1, revisions: 2, conflicts: [], config: null });
      expect(await readdir(f.folder)).toEqual([]);
      expect(f.config()).toBeNull();
      const switched = await changeMemoryLocation(f.deps, f.actor, {
        ...input,
        expectedHash: preview.hash,
      });
      expect(switched.config).toMatchObject({
        generation: 1,
        documentStore: "obsidian",
        provider: "builtin",
      });
      expect(f.database.documents.get(f.doc.id)?.content).toBe("Second revision");
      const selected = await selectDocumentStore(f.tx, f.config(), f.deps.dataDir);
      await selected.commit(
        {
          ...memoryTestCommit(f.access),
          id: f.doc.id,
          expectedRevision: 2,
          content: "Written in the vault",
        },
        f.access,
      );
      const back = await changeMemoryLocation(f.deps, f.actor, {
        location: "postgres",
        expectedGeneration: 1,
      });
      expect(back.revisions).toBe(3);
      expect(back.conflicts).toEqual([]);
      await changeMemoryLocation(f.deps, f.actor, {
        location: "postgres",
        expectedGeneration: 1,
        expectedHash: back.hash,
      });
      expect(f.database.documents.get(f.doc.id)?.content).toBe("Written in the vault");
      expect((await readdir(path.join(f.folder, "history", f.doc.id))).length).toBe(3);
    } finally {
      await f.dispose();
    }
  });
  it("rejects stale previews, stale generations and non-owner local path registration", async () => {
    const f = await fixture();
    try {
      const input = { location: "obsidian" as const, folder: f.folder, expectedGeneration: 0 };
      await expect(
        changeMemoryLocation(f.deps, f.actor, { ...input, expectedHash: "stale" }),
      ).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
      await expect(
        changeMemoryLocation(f.deps, f.actor, { ...input, expectedGeneration: 8 }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        changeMemoryLocation(f.deps, { ...f.actor, isDeploymentOwner: false }, input),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(f.config()).toBeNull();
      expect(await readdir(f.folder)).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
});
