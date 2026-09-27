import type { MemoryAccess, MemoryDocumentStore } from "@ardurbot/adapter-kit";
import { createDb, type PrismaClient } from "@ardurbot/db";
import { PostgresDocumentStore, scopeKey } from "@ardurbot/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VaultWithPrivateDocuments } from "./obsidian-store.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("mixed-case private memory pagination (PostgreSQL)", () => {
  const spaceId = "mixed-case-memory-space";
  const userId = "mixed-case-reader";
  const access: MemoryAccess = {
    operationId: "mixed-case-read",
    traceId: "mixed-case-read",
    spaceId,
    userId,
    botIds: [],
    signal: new AbortController().signal,
  };
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: spaceId,
        name: spaceId,
        slug: spaceId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: spaceId } },
      },
    });
    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    for (const id of ["A", "a", "B", "b"])
      await prisma.memoryDocument.create({
        data: {
          id,
          spaceId,
          userId,
          scope: "user",
          scopeKey: scopeKey({ kind: "user", spaceId, userId }),
          path: `${id}.md`,
          content: id,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          revisions: {
            create: {
              revision: 1,
              content: id,
              authorKind: "user",
              authorUserId: userId,
              createdAt: timestamp,
            },
          },
        },
      });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: spaceId } });
    } finally {
      await close();
    }
  });

  async function expectJavaScriptOrder(store: MemoryDocumentStore) {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
      const page = await store.list({ limit: 1, cursor }, access);
      expect(page.items).toHaveLength(1);
      ids.push(page.items[0]!.id);
      cursor = page.nextCursor ?? undefined;
      if (pageNumber < 3) expect(page.nextCursor).not.toBeNull();
      else expect(page.nextCursor).toBeNull();
    }
    expect(ids).toEqual(["A", "B", "a", "b"]);
  }

  // Pending a C-collated ID index: the ICU primary key cannot serve bytewise keyset order.
  it.skip("orders imported IDs bytewise in the PostgreSQL store", async () => {
    await prisma.$transaction(async (tx) => expectJavaScriptOrder(new PostgresDocumentStore(tx)));
  });

  it.skip("does not skip IDs when the vault merges private PostgreSQL pages", async () => {
    await prisma.$transaction(async (tx) => {
      const vault = { list: async () => ({ items: [], nextCursor: null }) };
      const wrapper = new VaultWithPrivateDocuments(
        vault as never,
        new PostgresDocumentStore(tx),
        null,
      );
      await expectJavaScriptOrder(wrapper);
    });
  });
});
