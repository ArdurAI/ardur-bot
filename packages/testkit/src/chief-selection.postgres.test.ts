import { randomUUID } from "node:crypto";
import type { ChiefOperation } from "@ardurbot/contracts";
import { ChiefDispatchSchema } from "@ardurbot/contracts";
import {
  createChiefReceipt,
  createDb,
  loadChiefMemberFacts,
  loadChiefSelectionContext,
  provisionMessagingIdentity,
  readChiefReceipt,
  saveChiefSelection,
  validateChiefDispatch,
} from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
// Disposable CI fixtures only; no app, model, computer or external write runs.
describe.skipIf(!enabled).sequential("chief selection database facts", () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function fixture(app: "linear" | "github" = "linear") {
    const mine = await provisionMessagingIdentity(
      db.prisma,
      { provider: "sendblue", address: `fixture-${randomUUID()}` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const scope = { spaceId: mine.spaceId, userId: mine.userId };
    const chief = await db.prisma.bot.findUniqueOrThrow({ where: { id: mine.botId } });
    const computer = await db.prisma.computer.create({
      data: {
        ...scope,
        scopeKey: randomUUID(),
        homeKey: randomUUID(),
        kind: "docker",
        state: "running",
      },
    });
    const workers = await Promise.all(
      ["First member", "Second member"].map((name) =>
        db.prisma.bot.create({
          data: {
            ...scope,
            name,
            color: chief.color,
            title: "operations",
            computerId: computer.id,
            runtimeKind: "pi",
            modelProvider: "fixture",
            modelId: "fixed",
            modelPinRevision: 3,
            concurrentRuns: 1,
          },
        }),
      ),
    );
    const group = await db.prisma.chatGroup.create({
      data: {
        ...scope,
        name: "Selection fixture",
        coordinatorBotId: chief.id,
        members: { create: [chief, ...workers].map((bot) => ({ botId: bot.id })) },
        thread: { create: scope },
      },
      include: { thread: true },
    });
    if (!group.thread) throw new Error("Fixture group requires a thread");
    const thread = group.thread;
    const server = await db.prisma.mcpServer.create({
      data: {
        ...scope,
        slug: `fixture-${app}`,
        name: `Fake ${app}`,
        transport: "streamable_http",
        catalogId: app,
        connectionState: "connected",
        manifest: {
          capturedAt: new Date().toISOString(),
          serverVersion: "fixture",
          account: null,
          tools: [
            { id: "fetch_item", description: "Read an item", inputSchemaDigest: "a".repeat(64) },
            { id: "create_item", description: "Create an item", inputSchemaDigest: "b".repeat(64) },
          ],
        },
        spaceAllowedTools: ["fetch_item", "create_item"],
        spaceToolPolicies: { fetch_item: "allow", create_item: "ask-first" },
        assignments: {
          create: [chief, ...workers].map((bot) => ({
            ...scope,
            botId: bot.id,
            access: "custom",
            allowedTools: bot.id === chief.id ? [] : ["fetch_item", "create_item"],
          })),
        },
      },
    });
    const operation: ChiefOperation =
      app === "linear"
        ? { taskType: "operations", purpose: "create-issue" }
        : { taskType: "code-change", purpose: "manage-repository" };
    async function select() {
      const task = await db.prisma.task.create({
        data: {
          ...scope,
          botId: chief.id,
          threadId: thread.id,
          prompt: "Fixture request",
          status: "queued",
        },
      });
      const run = await db.prisma.run.create({
        data: {
          ...scope,
          botId: chief.id,
          threadId: thread.id,
          taskId: task.id,
          status: "queued",
          trigger: "user",
        },
      });
      const request = await db.prisma.message.create({
        data: {
          threadId: thread.id,
          seq:
            (
              await db.prisma.thread.update({
                where: { id: thread.id },
                data: { nextMessageSeq: { increment: 1 } },
              })
            ).nextMessageSeq - 1,
          role: "user",
          blocks: [{ kind: "text", text: "Fixture request" }],
        },
      });
      const plan = await db.prisma.$transaction((tx) =>
        saveChiefSelection(tx, {
          ...scope,
          groupId: group.id,
          threadId: thread.id,
          chiefBotId: chief.id,
          sourceMessageId: request.id,
          sourceRunId: run.id,
          taskId: task.id,
          operation,
        }),
      );
      return { plan, run };
    }
    return { scope, chief, computer, workers, group, thread, server, operation, select };
  }

  it.each(["linear", "github"] as const)(
    "saves and replays the %s access blocker without a model response",
    async (app) => {
      const f = await fixture(app);
      await db.prisma.mcpServer.update({
        where: { id: f.server.id },
        data: { connectionState: "needs-sign-in" },
      });
      const { plan, run } = await f.select();
      const blocker = `Connect ${app === "linear" ? "Linear" : "GitHub"} or grant a team member permission to read and write.`;
      expect(plan.decision).toEqual({ kind: "needs-owner", blockerKey: `connect-${app}`, blocker });
      expect(await loadChiefSelectionContext(db.prisma, run.id)).toContain(
        `Assignment is blocked: ${blocker}`,
      );
      expect(
        await db.prisma.$transaction((tx) =>
          validateChiefDispatch(
            tx,
            { ...f.scope, id: run.id, botId: f.chief.id, threadId: f.thread.id },
            f.group.id,
            f.workers[0]!.id,
          ),
        ),
      ).toEqual({ error: blocker });
      const saved = await db.prisma.$transaction((tx) =>
        createChiefReceipt(tx, {
          ...f.scope,
          threadId: f.thread.id,
          chiefBotId: f.chief.id,
          requestMessageId: plan.sourceMessageId,
          key: app === "linear" ? "create-issue" : "manage-repository",
          selection: plan,
        }),
      );
      expect(saved.receipt).toMatchObject({
        key: "needs-owner",
        chiefDispatch: { state: "needs-owner", blockerKey: `connect-${app}`, reason: blocker },
      });
      expect(await readChiefReceipt(db.prisma, f.thread.id, plan.sourceMessageId)).toEqual(
        saved.receipt,
      );
      expect(
        ChiefDispatchSchema.parse(
          (await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: plan.id } })).dispatch,
        ).state,
      ).toBe("needs-owner");
      expect(await db.prisma.delegation.count({ where: { parentRunId: run.id } })).toBe(0);
    },
  );

  it.each(["linear", "github"] as const)(
    "rejects read-only %s assignments, queues a leased computer, and breaks ties by id",
    async (app) => {
      const f = await fixture(app);
      await db.prisma.botMcpServer.updateMany({
        where: { serverId: f.server.id },
        data: { allowedTools: ["fetch_item"] },
      });
      expect((await f.select()).plan.decision).toMatchObject({ kind: "needs-owner" });
      await db.prisma.botMcpServer.updateMany({
        where: { serverId: f.server.id, botId: { in: f.workers.map((worker) => worker.id) } },
        data: { allowedTools: ["fetch_item", "create_item"] },
      });
      const winner = f.workers.map((worker) => worker.id).sort()[0]!;
      const ready = await f.select();
      expect(ready.plan.decision).toMatchObject({ kind: "delegate", memberId: winner });
      // Both workers share this computer, so its lease blocks both even when one has no active run.
      const busyTask = await db.prisma.task.create({
        data: {
          ...f.scope,
          botId: winner,
          threadId: f.thread.id,
          prompt: "Busy fixture",
          status: "running",
        },
      });
      const busyRun = await db.prisma.run.create({
        data: {
          ...f.scope,
          botId: winner,
          threadId: f.thread.id,
          taskId: busyTask.id,
          status: "running",
          trigger: "user",
        },
      });
      await db.prisma.computerExecutionLease.create({
        data: {
          computerId: f.computer.id,
          runId: busyRun.id,
          botId: winner,
          fence: 1,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect((await f.select()).plan.decision).toMatchObject({
        kind: "queue",
        memberId: f.workers.find((worker) => worker.id !== winner)!.id,
      });
      const facts = await loadChiefMemberFacts(db.prisma, f.scope, f.group.id);
      expect(facts.find((member) => member.id === winner)).toMatchObject({
        computer: { leaseBusy: true },
        capabilities: expect.arrayContaining([
          { id: `${app}:write`, access: "known", checkedAt: expect.any(String) },
        ]),
      });
      // Selection does not turn the saved ask-first write policy into approval.
      expect(
        (await db.prisma.mcpServer.findUniqueOrThrow({ where: { id: f.server.id } }))
          .spaceToolPolicies,
      ).toEqual({ fetch_item: "allow", create_item: "ask-first" });
      expect(await db.prisma.externalEffect.count({ where: { spaceId: f.scope.spaceId } })).toBe(0);
    },
  );

  it("denies dispatch after explicit write revocation, while deleting an assignment restores inheritance", async () => {
    const f = await fixture();
    const { plan, run } = await f.select();
    const winner = f.workers.map((worker) => worker.id).sort()[0]!;
    expect(plan.decision).toMatchObject({ kind: "delegate", memberId: winner });
    const validate = () =>
      db.prisma.$transaction((tx) =>
        validateChiefDispatch(
          tx,
          { ...f.scope, id: run.id, botId: f.chief.id, threadId: f.thread.id },
          f.group.id,
          winner,
        ),
      );
    await db.prisma.botMcpServer.updateMany({
      where: { serverId: f.server.id, botId: winner },
      data: { access: "custom", allowedTools: ["fetch_item"] },
    });
    expect(await validate()).toEqual({
      error: "Connect Linear or grant a team member permission to read and write.",
    });
    expect(await db.prisma.delegation.count({ where: { parentRunId: run.id } })).toBe(0);
    await db.prisma.botMcpServer.deleteMany({
      where: { serverId: f.server.id, botId: winner },
    });
    expect(await validate()).toMatchObject({
      planId: plan.id,
      dispatch: { state: "messaged", memberId: winner },
    });
  });
});
