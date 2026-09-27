import type { DocumentListInput, DocumentScope, MemoryAccess } from "@ardurbot/adapter-kit";
import { MemoryAccessError } from "@ardurbot/adapter-kit";
import { createDb, type PrismaClient } from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JournalDocumentStore } from "./journal.js";
import { PostgresDocumentStore, PostgresMemoryJournal } from "./postgres-store.js";
import { scopeKey } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("scoped memory reads (PostgreSQL)", () => {
  const space = "scoped-read-space";
  const otherSpace = "scoped-read-other-space";
  const paginationSpace = "scoped-read-pagination-space";
  const user = "reader";
  const bot = "reader-bot";
  const otherBot = "other-bot";
  const access: MemoryAccess = {
    operationId: "scoped-read",
    traceId: "scoped-read",
    spaceId: space,
    userId: user,
    botIds: [bot],
    groupIds: ["alpha", "beta"],
    signal: new AbortController().signal,
  };
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  function document(id: string, scope: DocumentScope, deleted = false) {
    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    return {
      id,
      spaceId: scope.spaceId,
      userId: "userId" in scope ? scope.userId : user,
      botId: "botId" in scope ? scope.botId : null,
      scope: scope.kind,
      scopeKey: scopeKey(scope),
      path: `${id}.md`,
      kind: "topic",
      content: deleted ? "" : id,
      revision: 1,
      deletedAt: deleted ? timestamp : null,
      createdAt: timestamp,
      updatedAt: timestamp,
      revisions: {
        create: {
          revision: 1,
          kind: "topic",
          content: deleted ? "" : id,
          authorKind: "user",
          authorUserId: user,
          deletedAt: deleted ? timestamp : null,
          createdAt: timestamp,
        },
      },
    };
  }

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    for (const id of [space, otherSpace, paginationSpace]) {
      await prisma.organization.create({
        data: {
          id,
          name: id,
          slug: id,
          createdAt: new Date(),
          spaces: {
            create: {
              id,
              name: id,
              bots: {
                create: [
                  { id: `${id}-bot`, userId: user, name: "Bot", color: "ink" },
                  ...(id === space
                    ? [
                        { id: bot, userId: user, name: "Reader", color: "ink" },
                        { id: otherBot, userId: user, name: "Other", color: "ink" },
                      ]
                    : []),
                ],
              },
            },
          },
        },
      });
    }
    const scopes: Array<[string, DocumentScope, boolean?]> = [
      ["a-visible", { kind: "user", spaceId: space, userId: user }],
      ["z-visible", { kind: "space-shared", spaceId: space }],
      ["other-space", { kind: "space-shared", spaceId: otherSpace }],
      ["other-person", { kind: "user", spaceId: space, userId: "someone-else" }],
      ["other-bot-doc", { kind: "bot", spaceId: space, userId: user, botId: otherBot }],
      ["own-bot-doc", { kind: "bot", spaceId: space, userId: user, botId: bot }],
      [
        "alpha-brief",
        { kind: "group", spaceId: space, userId: user, botId: bot, groupId: "alpha" },
      ],
      ["beta-brief", { kind: "group", spaceId: space, userId: user, botId: bot, groupId: "beta" }],
      ["deleted-doc", { kind: "user", spaceId: space, userId: user }, true],
    ];
    for (const [id, scope, deleted] of scopes)
      await prisma.memoryDocument.create({ data: document(id, scope, deleted) });
    for (const id of ["a-page", "c-page"])
      await prisma.memoryDocument.create({
        data: document(id, { kind: "user", spaceId: paginationSpace, userId: user }),
      });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({
        where: { id: { in: [space, otherSpace, paginationSpace] } },
      });
    } finally {
      await close();
    }
  });

  it.each([
    ["other-space", access],
    ["other-person", access],
    ["other-bot-doc", access],
    ["beta-brief", { ...access, runId: "run-alpha", groupId: "alpha" }],
  ] as Array<[string, MemoryAccess]>)(
    "hides %s from read, list, and history",
    async (id, actor) => {
      await prisma.$transaction(async (tx) => {
        const store = new PostgresDocumentStore(tx);
        expect(await store.read(id, actor), id).toBeNull();
        expect(
          (await store.list({ includeDeleted: true }, actor)).items.map((item) => item.id),
          id,
        ).not.toContain(id);
        await expect(store.history(id, {}, actor), id).rejects.toBeInstanceOf(MemoryAccessError);
      });
    },
  );

  it("keeps page size and cursors identical when a hidden document is inserted", async () => {
    const actor = { ...access, spaceId: paginationSpace };
    const first = async () =>
      prisma.$transaction(async (tx) => {
        const store = new PostgresDocumentStore(tx);
        const page = await store.list({ limit: 1, scope: "user" }, actor);
        const next = await store.list({ limit: 1, scope: "user", cursor: page.nextCursor! }, actor);
        return { first: page, next };
      });
    const before = await first();
    expect(before.first.items.map((item) => item.id)).toEqual(["a-page"]);
    expect(before.first.nextCursor).toBe("a-page");
    expect(before.next.items.map((item) => item.id)).toEqual(["c-page"]);
    expect(before.next.nextCursor).toBeNull();
    await prisma.memoryDocument.create({
      data: document("b-hidden", {
        kind: "user",
        spaceId: paginationSpace,
        userId: "someone-else",
      }),
    });
    const after = await first();
    expect(after.first.items).toHaveLength(before.first.items.length);
    expect(after.next.items).toHaveLength(before.next.items.length);
    expect(after.first.nextCursor).toBe(before.first.nextCursor);
    expect(after.next.nextCursor).toBe(before.next.nextCursor);
    expect(after.next.items.map((item) => item.id)).toEqual(["c-page"]);
    expect(after).toEqual(before);
  });

  it("passes bounded take arguments to Prisma for heads and revisions", async () => {
    let headQueries = 0;
    let historyQueries = 0;
    const observed = prisma.$extends({
      query: {
        memoryDocument: {
          async findMany({ args, query }) {
            headQueries++;
            expect(args.take).toBeLessThanOrEqual(3);
            if (args.select?.revisions && typeof args.select.revisions === "object")
              expect(args.select.revisions.take).toBeLessThanOrEqual(1);
            return query(args);
          },
        },
        memoryRevision: {
          async findMany({ args, query }) {
            historyQueries++;
            expect(args.take).toBeLessThanOrEqual(3);
            return query(args);
          },
        },
      },
    }) as PrismaClient;
    await observed.$transaction(async (tx) => {
      const store = new PostgresDocumentStore(tx);
      await store.read("a-visible", access);
      await store.list({ limit: 2 }, access);
      await store.history("a-visible", { limit: 2 }, access);
    });
    expect(headQueries).toBe(3);
    expect(historyQueries).toBe(1);
  });

  it("matches the journal store for 27 actor and filter combinations", async () => {
    const actors: MemoryAccess[] = [
      access,
      { ...access, botId: bot },
      { ...access, runId: "run-alpha", groupId: "alpha" },
    ];
    const inputs: DocumentListInput[] = [
      {},
      { limit: 2 },
      { limit: 2, cursor: "a-visible" },
      { botId: bot },
      { groupId: "alpha" },
      { scope: "user" },
      { scope: "bot" },
      { includeDeleted: true },
      { scope: "group", groupId: "beta", includeDeleted: true },
    ];
    for (const actor of actors)
      for (const input of inputs) {
        await prisma.$transaction(async (tx) => {
          const reference = new JournalDocumentStore(new PostgresMemoryJournal(tx), "reference");
          const direct = new PostgresDocumentStore(tx);
          expect(await direct.list(input, actor)).toEqual(await reference.list(input, actor));
        });
      }
    await prisma.$transaction(async (tx) => {
      const reference = new JournalDocumentStore(new PostgresMemoryJournal(tx), "reference");
      const direct = new PostgresDocumentStore(tx);
      expect(await direct.read("a-visible", access)).toEqual(
        await reference.read("a-visible", access),
      );
      expect(await direct.history("a-visible", {}, access)).toEqual(
        await reference.history("a-visible", {}, access),
      );
    });
  });
});
