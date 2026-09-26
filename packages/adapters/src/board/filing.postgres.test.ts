import { randomUUID } from "node:crypto";
import type { WorkItem } from "@ardurbot/contracts/board";
import type { Prisma } from "@ardurbot/db";
import {
  createDb,
  createFilingLockPool,
  lockLearningProposal,
  observeBoardItems,
} from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordPendingCloseFailure, releaseChangedBoardClose } from "./pending-close.js";
import { BoardService } from "./service.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const closedItem = (id: string, closeReason: string) =>
  ({
    id,
    title: "Finish the import follow-up",
    status: "closed",
    closeReason,
    closedAt: "2026-09-25T12:00:00.000Z",
    assignee: null,
    commentCount: 0,
  }) as WorkItem;

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!hasDb)("Board filings (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let other: ReturnType<typeof createDb>;
  const pools: Array<ReturnType<typeof createFilingLockPool>> = [];
  const users: string[] = [];
  let previousOwner: string | null | undefined;
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!, { poolMax: 4 });
    other = createDb(process.env.DATABASE_URL!, { poolMax: 2 });
    previousOwner = (await db.prisma.deploymentSettings.findUnique({ where: { id: "default" } }))
      ?.ownerUserId;
  });
  afterAll(async () => {
    if (!db) return;
    await db.prisma.organization.deleteMany({ where: { id: { in: users } } });
    await db.prisma.user.deleteMany({ where: { id: { in: users } } });
    if (previousOwner === undefined)
      await db.prisma.deploymentSettings.deleteMany({ where: { id: "default" } });
    else
      await db.prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { ownerUserId: previousOwner },
      });
    for (const pool of pools) await pool.end();
    for (const client of [db, other]) {
      await client.prisma.$disconnect();
      await client.pool.end();
    }
  });
  /** One owner, space, bot, board and applied board-item proposal. */
  async function fixture() {
    const prisma = db.prisma;
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "Fixture owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: {
        id,
        name: "Fixture",
        slug: id,
        createdAt: new Date(),
        spaces: { create: { id, name: "Fixture" } },
        members: {
          create: { id: `${id}-member`, userId: id, role: "owner", createdAt: new Date() },
        },
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: `${id}-space-member`,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: id },
      update: { ownerUserId: id },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Builder", color: "fixture-color" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const workspace = await prisma.boardWorkspace.create({
      data: { spaceId: id, ownerUserId: id, kind: "space", path: `/fixture/${id}`, prefix: "work" },
    });
    const proposal = await prisma.learningProposal.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        runId: randomUUID(),
        threadId: thread.id,
        historyGeneration: 0,
        fingerprint: randomUUID(),
        status: "applied",
        expiresAt: new Date(Date.now() + 86_400_000),
        body: {
          appliedBoardItem: {
            workspaceId: workspace.id,
            itemId: "work-a",
            updatedAt: "2026-09-25T11:00:00.000Z",
            commentCount: 0,
            duplicate: false,
          },
        },
      },
    });
    return { id, bot, workspace, proposal, scope: { userId: id, spaceId: id } };
  }
  const lockService = () => {
    const lockPool = createFilingLockPool(process.env.DATABASE_URL!);
    pools.push(lockPool);
    return new BoardService({ prisma: db.prisma, dataDir: "/fixture", lockPool });
  };

  it("lets one of two clients hold a space's filing lock while another space proceeds", async () => {
    const { id } = await fixture();
    const first = lockService();
    const second = lockService();
    const held = deferred();
    const release = deferred();
    const holding = first.withFilingLock({ spaceId: id }, async () => {
      held.resolve();
      await release.promise;
      return "first";
    });
    await held.promise;
    // A plain session stands in for another process: the key must be the one the service took.
    const probe = await other.pool.connect();
    try {
      const busy = await probe.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(1380019075, (hashtext($1::text) & -8) | 4) AS acquired",
        [id],
      );
      expect(busy.rows[0]?.acquired).toBe(false);
      await expect(
        second.withFilingLock({ spaceId: id }, async () => "second", { waitMs: 300 }),
      ).rejects.toMatchObject({ problem: { code: "busy" } });
      await expect(
        second.withFilingLock({ spaceId: randomUUID() }, async () => "elsewhere"),
      ).resolves.toBe("elsewhere");
      release.resolve();
      await expect(holding).resolves.toBe("first");
      await expect(
        second.withFilingLock({ spaceId: id }, async () => "second", { waitMs: 0 }),
      ).resolves.toBe("second");
      const free = await probe.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(1380019075, (hashtext($1::text) & -8) | 4) AS acquired",
        [id],
      );
      expect(free.rows[0]?.acquired).toBe(true);
      await probe.query("SELECT pg_advisory_unlock(1380019075, (hashtext($1::text) & -8) | 4)", [
        id,
      ]);
    } finally {
      release.resolve();
      probe.release();
    }
  });

  it("orders the proposal row lock before the filing row for concurrent writers", async () => {
    const { id, workspace, proposal } = await fixture();
    const filing = await db.prisma.botBoardFiling.create({
      data: {
        spaceId: id,
        workspaceId: workspace.id,
        itemId: "work-a",
        learningProposalId: proposal.id,
        closePending: "Undone from Learning",
        closeUpdatedAt: "2026-09-25T11:00:00.000Z",
        closeCommentCount: 0,
      },
    });
    const holder = deferred();
    const held = deferred();
    // Another writer holds the proposal row, so both writers below queue on it.
    const blocking = db.prisma.$transaction(
      async (tx) => {
        await lockLearningProposal(tx, proposal.id);
        held.resolve();
        await holder.promise;
      },
      { timeout: 20_000 },
    );
    await held.promise;
    const outcome = observeBoardItems(other.prisma, workspace.id, [
      closedItem("work-a", "Kept for the shop"),
    ]);
    const changed = releaseChangedBoardClose(db.prisma, {
      id: filing.id,
      spaceId: id,
      workspaceId: workspace.id,
      itemId: "work-a",
      learningProposalId: proposal.id,
      closePending: "Undone from Learning",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    holder.resolve();
    await blocking;
    await Promise.all([outcome, changed]);
    const saved = await db.prisma.learningProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(saved.body).toMatchObject({
      boardChanged: true,
      appliedBoardItem: { closeReason: "Kept for the shop" },
    });
  });

  it("records an outcome with one read, and clears it when the item reopens", async () => {
    const { id, workspace, proposal } = await fixture();
    const filing = await db.prisma.botBoardFiling.create({
      data: {
        spaceId: id,
        workspaceId: workspace.id,
        itemId: "work-a",
        learningProposalId: proposal.id,
      },
    });
    await observeBoardItems(db.prisma, workspace.id, [closedItem("work-a", "Closed")]);
    expect(
      await db.prisma.botBoardFiling.findUniqueOrThrow({ where: { id: filing.id } }),
    ).toMatchObject({ outcome: "completed", closedAt: new Date("2026-09-25T12:00:00.000Z") });
    await observeBoardItems(db.prisma, workspace.id, [
      { ...closedItem("work-a", ""), status: "open", closedAt: null },
    ]);
    expect(
      await db.prisma.botBoardFiling.findUniqueOrThrow({ where: { id: filing.id } }),
    ).toMatchObject({ outcome: null, closedAt: null });
    const reopened = await db.prisma.learningProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect((reopened.body as { appliedBoardItem: object }).appliedBoardItem).not.toHaveProperty(
      "closeReason",
    );
    await observeBoardItems(db.prisma, workspace.id, [closedItem("work-a", "Duplicate")]);
    expect(
      await db.prisma.botBoardFiling.findUniqueOrThrow({ where: { id: filing.id } }),
    ).toMatchObject({ outcome: "closed-other" });
  });

  it("keeps one owning filing per item and one filing per proposal", async () => {
    const { id, workspace, proposal } = await fixture();
    const owned = { spaceId: id, workspaceId: workspace.id, itemId: "work-a" };
    await db.prisma.botBoardFiling.create({ data: owned });
    await expect(db.prisma.botBoardFiling.create({ data: owned })).rejects.toMatchObject({
      code: "P2002",
    });
    await expect(
      db.prisma.botBoardFiling.create({ data: { ...owned, reused: true } }),
    ).resolves.toMatchObject({ reused: true });
    await db.prisma.botBoardFiling.create({
      data: { ...owned, itemId: "work-b", learningProposalId: proposal.id },
    });
    await expect(
      db.prisma.botBoardFiling.create({
        data: { ...owned, itemId: "work-c", learningProposalId: proposal.id },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("counts filing outcomes per bot from real rows", async () => {
    const { id, bot, workspace, scope } = await fixture();
    const other = await db.prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Analyst", color: "fixture-color" },
    });
    const row = (itemId: string, data: Partial<Prisma.BotBoardFilingUncheckedCreateInput>) => ({
      spaceId: id,
      workspaceId: workspace.id,
      itemId,
      botId: bot.id,
      ...data,
    });
    await db.prisma.botBoardFiling.createMany({
      data: [
        row("done", { outcome: "completed", closedAt: new Date() }),
        row("other", { outcome: "closed-other", closedAt: new Date() }),
        row("open", {}),
        row("reused", { reused: true, outcome: "completed" }),
        row("old", { createdAt: new Date(Date.now() - 31 * 86_400_000) }),
        { spaceId: id, botId: bot.id, runId: "hollow", titleKey: "hollow" },
        row("analyst", { botId: other.id, outcome: "completed", closedAt: new Date() }),
      ],
    });
    const service = new BoardService({ prisma: db.prisma, dataDir: "/fixture" });
    expect(await service.filingOutcomes(scope)).toEqual({
      bots: [
        { botId: other.id, name: "Analyst", filed: 1, done: 1, open: 0, other: 0 },
        { botId: bot.id, name: "Builder", filed: 3, done: 1, open: 1, other: 1 },
      ],
    });
  });

  it("stores a failed-close notice without a follow, and refuses one with no target", async () => {
    const { id, workspace, proposal } = await fixture();
    const filing = await db.prisma.botBoardFiling.create({
      data: {
        spaceId: id,
        workspaceId: workspace.id,
        itemId: "work-a",
        learningProposalId: proposal.id,
        closePending: "Rejected from Learning",
        closeAttempts: 4,
      },
    });
    await recordPendingCloseFailure(db.prisma, filing, async () => {
      throw new Error("Open the desktop app to use this board.");
    });
    const notices = await db.prisma.boardNotification.findMany({
      where: { workspaceId: workspace.id },
    });
    expect(notices).toEqual([
      expect.objectContaining({
        followId: null,
        userId: id,
        itemId: "work-a",
        title: "A board item filed by a bot could not be closed.",
        changes: ["close"],
      }),
    ]);
    expect(await db.prisma.boardFollow.count({ where: { workspaceId: workspace.id } })).toBe(0);
    await expect(
      db.prisma
        .$executeRaw`INSERT INTO board_notifications (id, version, title, changes) VALUES (${randomUUID()}, 0, 'x', ARRAY['close'])`,
    ).rejects.toThrow(/board_notifications_target_check/);
  });
});
