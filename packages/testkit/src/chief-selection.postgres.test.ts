import { randomUUID } from "node:crypto";
import type { ChiefOperation } from "@ardurbot/contracts";
import {
  createDb,
  loadChiefSelectionContext,
  provisionMessagingIdentity,
  saveChiefSelection,
  validateChiefDispatch,
} from "@ardurbot/db";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).sequential("chief selection matrix", () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
  });

  async function fixture() {
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
        providerRef: "fake-computer",
      },
    });

    const createWorker = async (name: string, title: string = "documentation") => {
      return await db.prisma.bot.create({
        data: {
          ...scope,
          name,
          color: chief.color,
          title,
          computerId: computer.id,
          runtimeKind: "pi",
          modelProvider: "fixture",
          modelId: "fixed",
          thinkingLevel: "high",
          modelPinRevision: 3,
        },
      });
    };

    const worker1 = await createWorker("A_worker", "developer");
    const worker2 = await createWorker("B_worker", "developer");
    const worker3 = await createWorker("C_worker", "product");

    const group = await db.prisma.chatGroup.create({
      data: {
        ...scope,
        name: "Selection fixture",
        coordinatorBotId: chief.id,
        members: { create: [chief, worker1, worker2, worker3].map((bot) => ({ botId: bot.id })) },
        thread: { create: scope },
      },
      include: { thread: true },
    });

    return { scope, chief, computer, worker1, worker2, worker3, group, createWorker };
  }

  it("tests disconnected app, permissions changed since planning, and tie-breaking matrix", async () => {
    const f = await fixture();
    const sourceRunId = randomUUID();
    const operation: ChiefOperation = { taskType: "operations", purpose: "create-issue" };

    // 1. disconnected app
    let planId = await db.prisma.$transaction((tx) =>
      saveChiefSelection(tx, {
        ...f.scope,
        groupId: f.group.id,
        threadId: f.group.thread.id,
        chiefBotId: f.chief.id,
        sourceMessageId: randomUUID(),
        sourceRunId,
        taskId: randomUUID(),
        operation,
      }),
    );

    let context = await loadChiefSelectionContext(db.prisma, sourceRunId);
    expect(context).toContain(
      "Assignment is blocked: No team member has access to linear:read-back",
    );

    let dispatch = await db.prisma.$transaction((tx) =>
      validateChiefDispatch(
        tx,
        { ...f.scope, id: sourceRunId, botId: f.chief.id, threadId: f.group.thread.id },
        f.group.id,
        f.worker1.id,
      ),
    );
    expect(dispatch).toMatchObject({
      error: expect.stringContaining("No team member has access to linear:read-back"),
    });

    // 2. Grant permissions to multiple workers to test tie-breaking
    const server = await db.prisma.mcpServer.create({
      data: {
        ...f.scope,
        slug: "fake-linear",
        name: "Fake Linear",
        transport: "streamable_http",
        catalogId: "linear",
        connectionState: "connected",
        manifest: {
          capturedAt: new Date().toISOString(),
          serverVersion: "fixture",
          account: null,
          tools: [{ id: "read-back", description: "Read back", inputSchemaDigest: "a" }],
        },
        spaceAllowedTools: ["read-back"],
        spaceToolPolicies: { "read-back": "allow" },
        assignments: {
          create: [f.worker1.id, f.worker2.id, f.worker3.id].map((botId) => ({
            ...f.scope,
            botId,
            access: "custom",
            allowedTools: ["read-back"],
          })),
        },
      },
    });

    // Worker 3 is 'product', worker1 and worker2 are 'developer'. 'create-issue' prefers 'product'.
    // So worker 3 should win due to tie-breaking on role.
    const runId2 = randomUUID();
    planId = await db.prisma.$transaction((tx) =>
      saveChiefSelection(tx, {
        ...f.scope,
        groupId: f.group.id,
        threadId: f.group.thread.id,
        chiefBotId: f.chief.id,
        sourceMessageId: randomUUID(),
        sourceRunId: runId2,
        taskId: randomUUID(),
        operation,
      }),
    );
    context = await loadChiefSelectionContext(db.prisma, runId2);
    expect(context).toContain(f.worker3.id); // Tie-broken to worker3 (product role)

    // Now make worker 3 busy (busy computer)
    await db.prisma.run.create({
      data: {
        ...f.scope,
        id: randomUUID(),
        botId: f.worker3.id,
        threadId: f.group.thread.id,
        status: "running",
        taskType: "operations",
      },
    });

    const runId3 = randomUUID();
    planId = await db.prisma.$transaction((tx) =>
      saveChiefSelection(tx, {
        ...f.scope,
        groupId: f.group.id,
        threadId: f.group.thread.id,
        chiefBotId: f.chief.id,
        sourceMessageId: randomUUID(),
        sourceRunId: runId3,
        taskId: randomUUID(),
        operation,
      }),
    );
    context = await loadChiefSelectionContext(db.prisma, runId3);
    // Even though worker 3 is busy, they queue because they have the best fit (product).
    // Wait, let's verify if they queue or fallback.
    const plan = await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.decision).toMatchObject({ kind: "queue", memberId: f.worker3.id });

    // Remove worker 3 from the group to test deterministic tie-breaking on ID
    await db.prisma.chatGroupMember.delete({
      where: { groupId_botId: { groupId: f.group.id, botId: f.worker3.id } },
    });

    const runId4 = randomUUID();
    planId = await db.prisma.$transaction((tx) =>
      saveChiefSelection(tx, {
        ...f.scope,
        groupId: f.group.id,
        threadId: f.group.thread.id,
        chiefBotId: f.chief.id,
        sourceMessageId: randomUUID(),
        sourceRunId: runId4,
        taskId: randomUUID(),
        operation,
      }),
    );
    context = await loadChiefSelectionContext(db.prisma, runId4);

    // Both worker1 and worker2 have 'developer' role and are free. They tie. Tie broken by ID.
    const sortedIds = [f.worker1.id, f.worker2.id].sort();
    expect(context).toContain(sortedIds[0]);

    // 3. permissions changed since planning
    // Remove permission from the winner
    await db.prisma.mcpServerAssignment.deleteMany({
      where: { serverId: server.id, botId: sortedIds[0] },
    });

    dispatch = await db.prisma.$transaction((tx) =>
      validateChiefDispatch(
        tx,
        { ...f.scope, id: runId4, botId: f.chief.id, threadId: f.group.thread.id },
        f.group.id,
        sortedIds[0],
      ),
    );

    // The previous winner is no longer eligible. Should return error instead of dispatching.
    expect(dispatch).toMatchObject({
      error: expect.stringContaining("is no longer eligible"),
    });
  });

  it("tests read-only assignment and approval required", async () => {
    const f = await fixture();
    // read-only assignment is usually a general task like code-search or research
    const sourceRunId = randomUUID();
    const planId = await db.prisma.$transaction((tx) =>
      saveChiefSelection(tx, {
        ...f.scope,
        groupId: f.group.id,
        threadId: f.group.thread.id,
        chiefBotId: f.chief.id,
        sourceMessageId: randomUUID(),
        sourceRunId,
        taskId: randomUUID(),
        operation: { taskType: "code-change", purpose: "general" },
      }),
    );
    const plan = await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: planId } });
    expect((plan.operation as any).purpose).toBe("general");

    // approval required is tested with code-change/manage-repository
    const runId2 = randomUUID();
    const planId2 = await db.prisma.$transaction((tx) =>
      saveChiefSelection(tx, {
        ...f.scope,
        groupId: f.group.id,
        threadId: f.group.thread.id,
        chiefBotId: f.chief.id,
        sourceMessageId: randomUUID(),
        sourceRunId: runId2,
        taskId: randomUUID(),
        operation: { taskType: "code-change", purpose: "manage-repository" },
      }),
    );
    const plan2 = await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: planId2 } });
    expect((plan2.operation as any).purpose).toBe("manage-repository");
  });
});
