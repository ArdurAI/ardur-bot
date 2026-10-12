import { describe, expect, it, vi } from "vitest";
import {
  createChiefReceipt,
  loadChiefMemberFacts,
  loadChiefSelectionContext,
  readChiefReceipt,
  saveChiefSelection,
  validateChiefDispatch,
} from "./chief-loop.js";
import type { Prisma, PrismaClient } from "./client.js";

describe("chief fact projection", () => {
  it("retains ordinary handoff boot admission without granting unverified preparation", async () => {
    const plan = {
      id: "plan",
      sourceMessageId: "request",
      revision: 1,
      control: null,
      operation: { purpose: "general", taskType: "unknown" },
      decision: { kind: "plan" },
      checkedFacts: [],
    };
    const tx = {
      chiefPlan: { findFirst: vi.fn(async () => plan) },
      bot: {
        findMany: vi.fn(async () => [
          {
            id: "member",
            name: "Renamed",
            title: "Writer",
            runtimeKind: "pi",
            modelId: "model",
            thinkingLevel: "high",
            modelPinRevision: 1,
            concurrentRuns: 1,
            space: { concurrentRuns: 1 },
            computer: null,
            taughtSkills: [],
            groupMembers: [{ createdAt: new Date(0), modelPinRevision: 1, runtimePin: null }],
          },
        ]),
      },
      run: { findMany: vi.fn(async () => []) },
      mcpServer: { findMany: vi.fn(async () => []) },
      computerExecutionLease: { findMany: vi.fn(async () => []) },
      botBrief: { findMany: vi.fn(async () => []) },
    };
    const scope = {
      spaceId: "space",
      userId: "owner",
      id: "run",
      botId: "chief",
      threadId: "thread",
    };
    const db = tx as unknown as Prisma.TransactionClient;
    expect(await validateChiefDispatch(db, scope, "room", "member")).toMatchObject({
      planId: "plan",
      dispatch: { memberId: "member", state: "messaged" },
    });
    tx.chiefPlan.findFirst.mockResolvedValue({
      ...plan,
      operation: { taskType: "operations", purpose: "install-tool" },
      decision: { kind: "delegate", memberId: "member" },
    } as typeof plan);
    expect(await validateChiefDispatch(db, scope, "room", "member")).toMatchObject({
      error: expect.stringContaining("no longer eligible"),
    });
    tx.bot.findMany.mockResolvedValue([]);
    tx.chiefPlan.findFirst.mockResolvedValue(plan);
    expect(await validateChiefDispatch(db, scope, "room", "member")).toMatchObject({
      error: expect.stringContaining("no longer an authorized"),
    });
  });
  it("projects only authorized scope keys even when passed a run or plan object", async () => {
    const tx = {
      bot: { findMany: vi.fn(async () => []) },
      run: { findMany: vi.fn(async () => []) },
      mcpServer: { findMany: vi.fn(async () => []) },
      computerExecutionLease: { findMany: vi.fn(async () => []) },
      botBrief: { findMany: vi.fn(async () => []) },
    };
    const plan = {
      spaceId: "space",
      userId: "owner",
      groupId: "room",
      sourceRunId: "run",
      taskId: "task",
      operation: { purpose: "general" },
    };
    expect(
      await loadChiefMemberFacts(tx as unknown as Prisma.TransactionClient, plan, "room"),
    ).toEqual([]);
    const query = tx.bot.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(query[0].where).toEqual({
      spaceId: "space",
      userId: "owner",
      archivedAt: null,
      groupMembers: {
        some: { groupId: "room", group: { spaceId: "space", userId: "owner", archivedAt: null } },
      },
    });
  });
});

describe("connected app selection data path", () => {
  const scope = { spaceId: "space", userId: "owner" };
  const input = {
    ...scope,
    groupId: "room",
    threadId: "thread",
    chiefBotId: "chief",
    sourceMessageId: "request",
    sourceRunId: "run",
    taskId: "task",
    operation: { taskType: "operations", purpose: "create-issue" } as const,
  };
  const blocker = "Connect Linear or grant a team member permission to read and write.";
  function fixture() {
    const bots = ["chief", "worker"].map((id) => ({
      id,
      name: id === "chief" ? "Chief" : "Member",
      title: "operations",
      runtimeKind: "pi",
      modelId: "fixed",
      thinkingLevel: "high",
      modelPinRevision: 1,
      concurrentRuns: 1,
      space: { concurrentRuns: 1 },
      computer:
        id === "chief"
          ? null
          : {
              id: "computer",
              kind: "docker",
              state: "running",
              connectionId: null,
              controlHolder: "none",
              controlLeaseExpiresAt: null,
            },
      taughtSkills: [],
      groupMembers: [{ createdAt: new Date(0), modelPinRevision: 1, runtimePin: null }],
    }));
    const server = {
      catalogId: "linear",
      connectionState: "connected",
      lastCheckedAt: new Date(0),
      needsReview: false,
      spaceAllowedTools: ["fetch_item", "create_item"],
      manifest: {
        capturedAt: new Date(0).toISOString(),
        serverVersion: "fixture",
        account: null,
        tools: [
          { id: "fetch_item", description: "Read item", inputSchemaDigest: "a".repeat(64) },
          { id: "create_item", description: "Create item", inputSchemaDigest: "b".repeat(64) },
        ],
      },
      assignments: [
        {
          botId: "worker",
          access: "custom",
          allowedTools: ["fetch_item", "create_item"],
          needsReview: false,
        },
      ],
    };
    let plan: Record<string, unknown> | null = null;
    let message: Record<string, unknown> | null = null;
    const tx = {
      bot: { findMany: vi.fn(async () => bots) },
      run: { findMany: vi.fn(async () => []) },
      mcpServer: { findMany: vi.fn(async () => [server]) },
      computerExecutionLease: { findMany: vi.fn(async () => []) },
      botBrief: { findMany: vi.fn(async () => []) },
      chiefAssignment: { upsert: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) },
      chiefPlan: {
        create: vi.fn(
          async ({ data }) => (plan = { ...data, id: "plan", revision: 1, control: null }),
        ),
        findFirst: vi.fn(async () => plan),
        update: vi.fn(async ({ data }) => (plan = { ...plan, ...data })),
      },
      thread: { update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 3 })) },
      message: {
        create: vi.fn(
          async ({ data }) => (message = { ...data, id: "receipt", createdAt: new Date(0) }),
        ),
        findUnique: vi.fn(async () => message),
      },
      event: { create: vi.fn(async ({ data }) => ({ ...data, id: "event" })) },
    };
    return {
      tx,
      db: tx as unknown as Prisma.TransactionClient,
      prisma: tx as unknown as PrismaClient,
      server,
    };
  }
  it("persists, publishes and replays a blocked receipt before any model can answer", async () => {
    const f = fixture();
    f.server.connectionState = "needs-sign-in";
    const plan = await saveChiefSelection(f.db, input);
    expect(plan.decision).toEqual({ kind: "needs-owner", blockerKey: "connect-linear", blocker });
    expect(plan.dispatch).toMatchObject({ state: "needs-owner", reason: blocker });
    const saved = await createChiefReceipt(f.db, {
      ...scope,
      threadId: input.threadId,
      chiefBotId: input.chiefBotId,
      requestMessageId: input.sourceMessageId,
      key: "create-issue",
      selection: plan,
    });
    expect(saved.receipt).toMatchObject({
      key: "needs-owner",
      text: "Got it — this task needs you before I can assign it.",
      chiefDispatch: { state: "needs-owner", blockerKey: "connect-linear", reason: blocker },
    });
    expect(f.tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "thread.message.created",
          payload: expect.objectContaining({
            blocks: [
              expect.objectContaining({
                key: "needs-owner",
                chiefDispatch: saved.receipt.chiefDispatch,
              }),
            ],
          }),
        }),
      }),
    );
    expect(await readChiefReceipt(f.prisma, input.threadId, input.sourceMessageId)).toEqual(
      saved.receipt,
    );
    expect(await loadChiefSelectionContext(f.prisma, input.sourceRunId)).toContain(
      `Assignment is blocked: ${blocker}`,
    );
    expect(
      await validateChiefDispatch(
        f.db,
        { ...scope, id: input.sourceRunId, botId: input.chiefBotId, threadId: input.threadId },
        input.groupId,
        "worker",
      ),
    ).toEqual({ error: blocker });
  });
  it.each(["revoked-write", "needs-review", "space-ceiling", "disconnected"])(
    "rechecks %s before dispatch and refuses unchecked replacement",
    async (change) => {
      const f = fixture();
      const plan = await saveChiefSelection(f.db, input);
      expect(plan.decision).toMatchObject({ kind: "delegate", memberId: "worker" });
      if (change === "revoked-write") f.server.assignments[0]!.allowedTools = ["fetch_item"];
      if (change === "needs-review") f.server.assignments[0]!.needsReview = true;
      if (change === "space-ceiling") f.server.spaceAllowedTools = ["fetch_item"];
      if (change === "disconnected") f.server.connectionState = "needs-sign-in";
      expect(
        await validateChiefDispatch(
          f.db,
          { ...scope, id: input.sourceRunId, botId: input.chiefBotId, threadId: input.threadId },
          input.groupId,
          "worker",
        ),
      ).toEqual({ error: blocker });
    },
  );
  it("keeps inherited authority distinct from an explicit denial", async () => {
    const f = fixture();
    f.server.assignments = [];
    expect((await saveChiefSelection(f.db, input)).decision).toMatchObject({
      kind: "delegate",
      memberId: "worker",
    });
    f.server.assignments = [
      { botId: "worker", access: "custom", allowedTools: [], needsReview: false },
    ];
    expect((await saveChiefSelection(f.db, input)).decision).toMatchObject({
      kind: "needs-owner",
      blocker,
    });
  });
});
