import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createDb } from "@ardurbot/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseBeadsItem } from "./beads.js";
import { reconcileBoardOutcomes } from "./reconcile.js";
import { BoardService } from "./service.js";
import { finishBoardRun } from "./tools.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!hasDb)("Board outcome delivery (PostgreSQL)", () => {
  let immediateDb: ReturnType<typeof createDb>;
  let reconciliationDb: ReturnType<typeof createDb>;
  const users: string[] = [];
  beforeAll(() => {
    immediateDb = createDb(process.env.DATABASE_URL!, { poolMax: 1 });
    reconciliationDb = createDb(process.env.DATABASE_URL!, { poolMax: 1 });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (!immediateDb) return;
    await immediateDb.prisma.organization.deleteMany({ where: { id: { in: users } } });
    await immediateDb.prisma.user.deleteMany({ where: { id: { in: users } } });
    for (const db of [immediateDb, reconciliationDb]) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  async function fixture(status: string) {
    const prisma = immediateDb.prisma;
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: {
        id,
        name: "Fixture",
        email: `${id}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: {
        id,
        name: "Fixture",
        slug: id,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    const bot = await prisma.bot.create({
      data: {
        spaceId: id,
        userId: id,
        name: "Fixture",
        color: "fixture-color",
      },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Review",
        status,
      },
    });
    const workspace = await prisma.boardWorkspace.create({
      data: {
        spaceId: id,
        ownerUserId: id,
        kind: "space",
        path: "/fixture/board",
        prefix: "board",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status,
        trigger: "user",
        error: "Outcome",
        boardWorkspaceId: workspace.id,
        boardItemId: "board-a",
        boardCloseWhenDone: true,
      },
    });
    return { run, scope: { runId: run.id, spaceId: id, userId: id, botId: bot.id } };
  }
  for (const status of ["completed", "failed", "cancelled"]) {
    it.each(["immediate", "reconciliation"])(
      `delivers ${status} once across database clients when %s starts first`,
      async (first) => {
        const { run, scope } = await fixture(status);
        const item = parseBeadsItem({
          id: run.boardItemId,
          title: "Task",
          metadata: { ardur_close_when_done: true },
        });
        const provider = {
          show: vi.fn(async () => structuredClone(item)),
          comment: vi.fn(async (_id: string, text: string) => {
            item.comments.push({ id: "comment", text, author: "bot:Builder", createdAt: "" });
          }),
          close: vi.fn(async () => {
            item.status = "closed";
          }),
        };
        vi.spyOn(BoardService.prototype, "provider").mockResolvedValue(provider as never);
        const read = deferred();
        const release = deferred();
        provider.show.mockImplementationOnce(async () => {
          const snapshot = structuredClone(item);
          read.resolve();
          await release.promise;
          return snapshot;
        });
        const immediate = () => finishBoardRun({ prisma: immediateDb.prisma }, scope, "Outcome");
        const reconcile = () =>
          reconcileBoardOutcomes({
            prisma: reconciliationDb.prisma,
            dataDir: tmpdir(),
          });
        const pending = first === "immediate" ? immediate() : reconcile();
        await read.promise;
        try {
          await (first === "immediate" ? reconcile() : immediate());
        } finally {
          release.resolve();
          await pending;
        }
        expect(provider.comment).toHaveBeenCalledTimes(1);
        expect(provider.close).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
        expect(
          await immediateDb.prisma.run.findUniqueOrThrow({ where: { id: run.id } }),
        ).toMatchObject({
          boardCommentedAt: expect.any(Date),
          boardDeliveryToken: null,
          boardDeliveryExpiresAt: null,
        });
        await Promise.all([immediate(), reconcile()]);
        expect(provider.comment).toHaveBeenCalledTimes(1);
      },
    );
  }
});
