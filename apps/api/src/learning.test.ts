import type { Actor, RuntimePin } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { createLearningService } from "./learning.js";

it("defaults to disabled, captures medium effort, and only lets a space owner configure review", async () => {
  const actor = { spaceId: "space", userId: "owner" } as Actor;
  let row: Record<string, unknown> | null = null;
  const member = vi.fn(async () => ({ role: "owner" }));
  const prisma = {
    spaceMember: { findUnique: member },
    spaceLearningConfig: {
      findUnique: vi.fn(async () => row),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        row = create;
        return row;
      }),
    },
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({
        credential: { id: "connection", provider: "openai-compatible" },
        modelId: "local-model",
        isDefault: true,
      })),
    },
  };
  const service = createLearningService({
    prisma: prisma as unknown as PrismaClient,
    jobs: {} as never,
  });
  const initial = await service.settings(actor);
  expect(initial).toMatchObject({
    enabled: false,
    destination: { modelId: "local-model", effort: "medium", credentialId: "connection" },
  });
  const configured = await service.configure(actor, { enabled: true });
  expect(configured.reviewerPin).toEqual(initial.destination);
  expect(row).toMatchObject({
    configuredBy: actor.userId,
    botDailyTokens: 30000,
    spaceDailyTokens: 150000,
  });
  prisma.spaceModelPreference.findFirst.mockResolvedValueOnce({
    credential: { id: "different", provider: "openai-compatible" },
    modelId: "other-model",
    isDefault: true,
  });
  expect((await service.settings(actor)).destination).toEqual(initial.destination);
  member.mockResolvedValueOnce({ role: "member" });
  await expect(
    service.configure(actor, { enabled: true, reviewerPin: initial.destination as RuntimePin }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(prisma.spaceLearningConfig.upsert).toHaveBeenCalledOnce();
});

it("lists scoped proposals with separate counts and opens only linked, surviving evidence", async () => {
  const actor = { spaceId: "space", userId: "user" } as Actor;
  const proposal = {
    id: "proposal",
    type: "memory",
    scope: { spaceId: "space", userId: "user", botId: "bot" },
    target: {},
    proposedContent: "Use numbered steps.",
    rationale: "Requested format",
    evidenceIds: ["evidence"],
    confidence: { label: "model estimate", value: 0.8 },
    diff: "+Use numbered steps.",
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "pending",
    evidenceWatermark: "server-only",
  };
  const row = { body: proposal, status: "pending", threadId: "thread", historyGeneration: 2 };
  const prisma = {
    spaceMember: { findUnique: vi.fn(async () => ({ role: "member" })) },
    bot: {
      findFirst: vi.fn(async () => ({ id: "bot" })),
      findMany: vi.fn(async () => [{ id: "bot", name: "Helper" }]),
    },
    learningProposal: {
      findMany: vi.fn(async () => [row]),
      count: vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(2),
      findFirst: vi.fn(async () => row),
    },
    reviewExecution: { findMany: vi.fn(async () => []) },
    spaceLearningConfig: { findUnique: vi.fn(async () => null) },
    learningInsight: { findMany: vi.fn(async () => []) },
    thread: { findFirst: vi.fn(async () => ({ id: "thread" }) as { id: string } | null) },
    proposalEvidence: {
      findFirst: vi.fn(async () => ({
        body: {
          id: "evidence",
          kind: "instruction-span",
          sourceClass: "human-message",
          actorId: "user",
          runId: "run",
          threadId: "thread",
          eventIds: [],
          redactionVersion: 1,
          excerpt: "Use numbered steps.",
        },
      })),
    },
  };
  const service = createLearningService({
    prisma: prisma as unknown as PrismaClient,
    jobs: {} as never,
  });
  const list = await service.list(actor, "bot");
  expect(list).toMatchObject({ pendingCount: 3, appliedThisWeek: 2 });
  expect(list.proposals[0]).not.toHaveProperty("evidenceWatermark");
  expect(prisma.learningProposal.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { spaceId: "space", userId: "user", botId: "bot" } }),
  );
  expect((await service.evidence(actor, "proposal", "evidence")).excerpt).toBe(
    "Use numbered steps.",
  );
  await expect(service.evidence(actor, "proposal", "unrelated")).rejects.toThrow();
  prisma.thread.findFirst.mockResolvedValueOnce(null);
  await expect(service.evidence(actor, "proposal", "evidence")).rejects.toThrow();
  expect(prisma.proposalEvidence.findFirst).toHaveBeenCalledTimes(1);
  expect(await service.proposal(actor, "proposal")).toMatchObject({ id: "proposal" });
  expect(prisma.learningProposal.findFirst).toHaveBeenLastCalledWith({
    where: { id: "proposal", spaceId: "space", userId: "user" },
  });
});

function boardProposalRow(
  actor: Actor,
  id: string,
  status: "applied" | "reverted",
  duplicate = false,
) {
  return {
    status,
    body: {
      id,
      type: "board-item",
      scope: { ...actor, botId: "bot" },
      target: {},
      boardItem: {
        title: `Finish ${id}`,
        description: "The run stopped before the import finished.",
        acceptanceCriteria: "The import completes.",
      },
      rationale: "Unfinished follow-up",
      evidenceIds: ["evidence-a"],
      confidence: { label: "model estimate", value: 0.8 },
      diff: `+Finish ${id}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      status,
      appliedBoardItem: {
        workspaceId: "workspace",
        itemId: `item-${id}`,
        updatedAt: "2026-09-25T12:00:00.000Z",
        duplicate,
      },
    },
  };
}

it("marks a rejected proposal as closing while the filing close is still pending", async () => {
  const actor = { spaceId: "space", userId: "user" } as Actor;
  const row = boardProposalRow(actor, "proposal", "applied");
  row.status = "rejected";
  row.body.status = "rejected";
  const service = createLearningService({
    prisma: {
      spaceMember: { findUnique: async () => ({ role: "member" }) },
      bot: { findFirst: async () => ({ id: "bot" }) },
      learningProposal: { findFirst: async () => row },
      botBoardFiling: {
        findMany: async () => [
          {
            learningProposalId: "proposal",
            closedAt: null,
            outcome: null,
            closePending: "Rejected from Learning",
          },
        ],
      },
    } as unknown as PrismaClient,
    jobs: {} as never,
  });
  await expect(service.proposal(actor, "proposal")).resolves.toMatchObject({
    status: "rejected",
    boardClosing: true,
  });
});

it("says a pending close could not be finished once its notice was sent", async () => {
  const actor = { spaceId: "space", userId: "user" } as Actor;
  const row = boardProposalRow(actor, "proposal", "applied");
  row.status = "rejected";
  row.body.status = "rejected";
  const filing = {
    learningProposalId: "proposal",
    closedAt: null,
    outcome: null,
    closePending: "Rejected from Learning",
    closeNoticeAt: null as Date | null,
  };
  const service = createLearningService({
    prisma: {
      spaceMember: { findUnique: async () => ({ role: "member" }) },
      bot: { findFirst: async () => ({ id: "bot" }) },
      learningProposal: { findFirst: async () => row },
      botBoardFiling: { findMany: async () => [filing] },
    } as unknown as PrismaClient,
    jobs: {} as never,
  });
  const closing = await service.proposal(actor, "proposal");
  expect(closing).toMatchObject({ boardClosing: true });
  expect(closing).not.toHaveProperty("boardCloseFailed");
  filing.closeNoticeAt = new Date("2026-09-25T13:00:00.000Z");
  await expect(service.proposal(actor, "proposal")).resolves.toMatchObject({
    boardClosing: true,
    boardCloseFailed: true,
  });
});

it("reports the recorded outcome for an applied board-item proposal", async () => {
  const actor = { spaceId: "space", userId: "user" } as Actor;
  const findMany = vi.fn(async () => [
    {
      learningProposalId: "proposal",
      closedAt: new Date("2026-09-25T13:00:00.000Z"),
      outcome: "completed",
    },
  ]);
  const service = createLearningService({
    prisma: {
      spaceMember: { findUnique: async () => ({ role: "member" }) },
      bot: { findFirst: async () => ({ id: "bot" }) },
      learningProposal: { findFirst: async () => boardProposalRow(actor, "proposal", "applied") },
      botBoardFiling: { findMany },
    } as unknown as PrismaClient,
    jobs: {} as never,
  });
  await expect(service.proposal(actor, "proposal")).resolves.toMatchObject({
    boardOutcome: { closedAt: "2026-09-25T13:00:00.000Z", outcome: "completed" },
  });
  expect(findMany).toHaveBeenCalledWith({
    where: { spaceId: "space", learningProposalId: { in: ["proposal"] } },
    select: {
      learningProposalId: true,
      closedAt: true,
      outcome: true,
      closePending: true,
      closeNoticeAt: true,
    },
  });
});

it("reports an unclassified closed outcome with its reason, without calling it done or not done", async () => {
  const actor = { spaceId: "space", userId: "user" } as Actor;
  const row = boardProposalRow(actor, "proposal", "applied");
  row.body.appliedBoardItem.closeReason = "Готово";
  const service = createLearningService({
    prisma: {
      spaceMember: { findUnique: async () => ({ role: "member" }) },
      bot: { findFirst: async () => ({ id: "bot" }) },
      learningProposal: { findFirst: async () => row },
      botBoardFiling: {
        findMany: async () => [
          {
            learningProposalId: "proposal",
            closedAt: new Date("2026-09-25T13:00:00.000Z"),
            outcome: "closed",
          },
        ],
      },
    } as unknown as PrismaClient,
    jobs: {} as never,
  });
  await expect(service.proposal(actor, "proposal")).resolves.toMatchObject({
    boardOutcome: {
      closedAt: "2026-09-25T13:00:00.000Z",
      outcome: "closed",
      closeReason: "Готово",
    },
  });
});

it("loads board outcomes for every listed proposal in one query", async () => {
  const actor = { spaceId: "space", userId: "user" } as Actor;
  const rows = [
    boardProposalRow(actor, "created", "applied"),
    boardProposalRow(actor, "reused", "applied", true),
    boardProposalRow(actor, "undone", "reverted"),
  ];
  const findFirst = vi.fn();
  const findMany = vi.fn(async () => [
    { learningProposalId: "created", closedAt: null, outcome: null },
    {
      learningProposalId: "reused",
      closedAt: new Date("2026-09-25T13:00:00.000Z"),
      outcome: "closed-other",
    },
  ]);
  const service = createLearningService({
    prisma: {
      spaceMember: { findUnique: vi.fn(async () => ({ role: "member" })) },
      bot: {
        findFirst: vi.fn(async () => ({ id: "bot" })),
        findMany: vi.fn(async () => [{ id: "bot", name: "Helper" }]),
      },
      learningProposal: { findMany: vi.fn(async () => rows), count: vi.fn(async () => 0) },
      reviewExecution: { findMany: vi.fn(async () => []) },
      spaceLearningConfig: { findUnique: vi.fn(async () => null) },
      learningInsight: { findMany: vi.fn(async () => []) },
      botBoardFiling: { findFirst, findMany },
    } as unknown as PrismaClient,
    jobs: {} as never,
  });
  const list = await service.list(actor, "bot");
  expect(findFirst).not.toHaveBeenCalled();
  expect(findMany).toHaveBeenCalledOnce();
  expect(findMany).toHaveBeenCalledWith({
    where: { spaceId: "space", learningProposalId: { in: ["created", "reused", "undone"] } },
    select: {
      learningProposalId: true,
      closedAt: true,
      outcome: true,
      closePending: true,
      closeNoticeAt: true,
    },
  });
  expect(list.proposals.map((proposal) => [proposal.id, proposal.boardOutcome])).toEqual([
    ["created", { closedAt: null, outcome: null, closeReason: null }],
    [
      "reused",
      { closedAt: "2026-09-25T13:00:00.000Z", outcome: "closed-other", closeReason: null },
    ],
    ["undone", undefined],
  ]);
});

it("keeps content-free audit entries in exports when their document no longer exists", async () => {
  const actor = { spaceId: "space", userId: "user" } as Actor;
  const service = createLearningService({
    prisma: {
      spaceMember: { findUnique: async () => ({ role: "member" }) },
      bot: { findFirst: async () => ({ id: "bot" }) },
      learningAudit: {
        findMany: async () => [
          {
            id: "audit",
            action: "approve",
            createdAt: new Date("2026-09-20Z"),
            scopeKey: "bot:bot",
            proposalId: "proposal",
            afterRevisionId: "removed:2",
            beforeRevisionId: null,
            grantId: null,
          },
        ],
      },
    } as never,
    memoryDocuments: { exportBundle: async () => ({ documents: [] }) } as never,
    jobs: {} as never,
  });
  const exported = await service.exportLearning(actor, "bot");
  expect(exported.journey).toMatchObject([{ revisionId: "removed:2", proposalId: "proposal" }]);
  expect(exported.observations).toEqual([]);
});

it("only lets the owner enqueue the curator and preserves explicit consolidation opt-in", async () => {
  const actor = { spaceId: "space", userId: "owner" } as Actor;
  const member = vi.fn(async () => ({ role: "owner" }));
  const jobs = { enqueue: vi.fn() };
  const prisma = {
    spaceMember: { findUnique: member },
    spaceLearningConfig: {
      findUnique: vi.fn(async () => ({ enabled: true, consolidationEnabled: false })),
    },
  };
  const service = createLearningService({ prisma: prisma as never, jobs: jobs as never });
  expect(await service.curate(actor)).toEqual({ ok: true });
  expect(jobs.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "learning.curate",
      payload: expect.objectContaining({
        spaceId: "space",
        requestedBy: "owner",
        requestId: expect.any(String),
      }),
    }),
  );
  member.mockResolvedValue({ role: "member" });
  await expect(service.curate(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(jobs.enqueue).toHaveBeenCalledOnce();
});
it("checks membership before exposing observations and passes the actor to the document lifecycle", async () => {
  const actor = { spaceId: "space", userId: "user" } as Actor;
  const member = vi.fn(async () => null);
  const memoryDocuments = { history: vi.fn(async () => ({ items: [] })) };
  const service = createLearningService({
    prisma: { spaceMember: { findUnique: member } } as never,
    jobs: {} as never,
    memoryDocuments: memoryDocuments as never,
  });
  await expect(service.observation(actor, "doc", 2)).rejects.toThrow();
  expect(memoryDocuments.history).not.toHaveBeenCalled();
});

function insightsPrisma(role: string, rows: Array<Record<string, unknown>> = []) {
  const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    rows.filter(
      (row) =>
        row.spaceId === where.spaceId &&
        row.userId === where.userId &&
        (!where.botId || row.botId === where.botId) &&
        !(where.kind as { notIn?: string[] } | undefined)?.notIn?.includes(String(row.kind)),
    ),
  );
  const updateMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => ({
    count: rows.filter(
      (row) =>
        row.id === where.id &&
        row.spaceId === where.spaceId &&
        row.userId === where.userId &&
        !(where.kind as { notIn?: string[] } | undefined)?.notIn?.includes(String(row.kind)),
    ).length,
  }));
  return {
    spaceMember: {
      findUnique: vi.fn(async ({ where }: { where: { spaceId_userId: { userId: string } } }) =>
        where.spaceId_userId.userId === "stranger" ? null : { role },
      ),
    },
    spaceLearningConfig: { findUnique: vi.fn(async () => null) },
    learningProposal: { count: vi.fn(async () => 0) },
    learningInsight: { findMany, updateMany },
    bot: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === "mine" && where.userId === "user" ? { id: "mine" } : null,
      ),
      findMany: vi.fn(async () => [{ id: "mine" }]),
    },
  };
}
const insightRow = (id: string, kind: string, userId = "user", botId: string | null = null) => ({
  id,
  spaceId: "space",
  userId,
  botId,
  kind,
  status: "active",
  evidence:
    kind === "memory-search"
      ? { kind, documents: 450, bytes: 90_000 }
      : { kind: "approval", botName: "Mine", tool: "notion_search_pages", approvals: 6, days: 7 },
  action:
    kind === "memory-search"
      ? { kind: "memory-settings" }
      : { kind: "approval-rule", botId: "mine", tool: "notion_search_pages" },
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
});

it("lists only the caller's insights, and space setup insights only for the owner", async () => {
  const rows = [
    insightRow("approval", "approval", "user", "mine"),
    insightRow("setup", "memory-search"),
    insightRow("theirs", "approval", "someone-else", "mine"),
  ];
  const actor = { spaceId: "space", userId: "user" } as Actor;
  const asMember = createLearningService({
    prisma: insightsPrisma("member", rows) as unknown as PrismaClient,
    jobs: {} as never,
  });
  expect((await asMember.insights(actor)).insights.map((i) => i.id)).toEqual(["approval"]);
  await expect(asMember.dismissInsight(actor, "setup")).rejects.toThrow();
  await expect(asMember.dismissInsight(actor, "theirs")).rejects.toThrow();
  await expect(asMember.insights(actor, "not-mine")).rejects.toThrow();
  await expect(
    asMember.insights({ spaceId: "space", userId: "stranger" } as Actor),
  ).rejects.toThrow();
  expect(await asMember.summary(actor)).toMatchObject({ insightCount: 1 });

  const asOwner = createLearningService({
    prisma: insightsPrisma("owner", rows) as unknown as PrismaClient,
    jobs: {} as never,
  });
  expect((await asOwner.insights(actor)).insights.map((i) => i.id)).toEqual(["approval", "setup"]);
  expect((await asOwner.insights(actor, "mine")).insights.map((i) => i.id)).toEqual(["approval"]);
  await expect(asOwner.actOnInsight(actor, "setup")).resolves.toEqual({ ok: true });
});

it("keeps the insight switch unless it is sent, and lets only the owner change it", async () => {
  const actor = { spaceId: "space", userId: "owner" } as Actor;
  let row: Record<string, unknown> | null = { insightsEnabled: false, enabled: false };
  const member = vi.fn(async () => ({ role: "owner" }));
  const enqueue = vi.fn(async () => undefined);
  const prisma = {
    spaceMember: { findUnique: member },
    spaceLearningConfig: {
      findUnique: vi.fn(async () => row),
      upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
        row = { ...row, ...update };
        return row;
      }),
    },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
  };
  const service = createLearningService({
    prisma: prisma as unknown as PrismaClient,
    jobs: { enqueue } as never,
  });
  expect(await service.configure(actor, { enabled: true })).toMatchObject({
    insightsEnabled: false,
  });
  expect(enqueue).not.toHaveBeenCalled();
  expect(await service.configure(actor, { enabled: true, insightsEnabled: true })).toMatchObject({
    insightsEnabled: true,
  });
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ name: "learning.insights", payload: { spaceId: "space" } }),
  );
  member.mockResolvedValue({ role: "member" });
  await expect(service.configure(actor, { insightsEnabled: false })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(row).toMatchObject({ insightsEnabled: true });
});

it("saves Always allow only for a read tool, re-checked on the server", async () => {
  const actor = { spaceId: "space", userId: "user" } as Actor;
  let action: Record<string, unknown> = {
    kind: "approval-rule",
    botId: "mine",
    tool: "github_delete_repo",
  };
  const upsert = vi.fn(async () => ({}));
  const update = vi.fn(async () => ({}));
  const prisma = {
    spaceMember: { findUnique: vi.fn(async () => ({ role: "member" })) },
    learningInsight: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        where.userId === "user" ? { action } : null,
      ),
      update,
    },
    bot: { findFirst: vi.fn(async () => ({ id: "mine" })) },
    actionApprovalRule: { upsert },
  };
  const client = {
    ...prisma,
    $transaction: async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  };
  const service = createLearningService({
    prisma: client as unknown as PrismaClient,
    jobs: {} as never,
  });
  await expect(service.allowInsightTool(actor, "insight")).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(upsert).not.toHaveBeenCalled();
  action = { kind: "approval-rule", botId: "mine", tool: "notion_search_pages" };
  await expect(service.allowInsightTool(actor, "insight")).resolves.toEqual({ ok: true });
  expect(upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({
        effect: "always_allow",
        matchKind: "tool",
        matchValue: "notion_search_pages",
        botId: "mine",
        scopeKey: "bot:mine",
      }),
    }),
  );
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "acted" }) }),
  );
});
