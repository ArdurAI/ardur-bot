import { createDb, IsolationError, type PrismaClient } from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listLearningInsights,
  loadInsightFacts,
  refreshLearningInsights,
  settleLearningInsight,
} from "./learning-insights.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("learning insights aggregation (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `insights-org-${suffix}`;
  const spaceId = `insights-space-${suffix}`;
  const ownerId = `insights-owner-${suffix}`;
  const memberId = `insights-member-${suffix}`;
  const owner = { spaceId, userId: ownerId };
  const member = { spaceId, userId: memberId };
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let seq = 0;
  let clock = Date.now() - 20 * 86_400_000;
  const tick = () => {
    clock += 60_000;
    return new Date(clock);
  };
  const next = () => {
    seq += 1;
    return seq;
  };

  const pin = (provider: string, modelId: string, credentialId: string, effort: string | null) => ({
    runtimeKind: "pi",
    provider,
    modelId,
    effort,
    credentialId,
    revision: 1,
  });
  const gpt = pin("openai", "gpt-4.1", `cred-openai-${suffix}`, "medium");
  const sonnet = pin("anthropic", "claude-sonnet-4-5", `cred-anthropic-${suffix}`, "medium");
  const llama = pin("ollama", "llama3", `cred-ollama-${suffix}`, null);

  async function bot(userId: string, name: string, runtimePin: typeof gpt) {
    const created = await prisma.bot.create({
      data: {
        spaceId,
        userId,
        name,
        color: "ink",
        modelProvider: runtimePin.provider,
        modelId: runtimePin.modelId,
        thinkingLevel: runtimePin.effort,
        modelCredentialId: runtimePin.credentialId,
      },
    });
    await prisma.thread.create({
      data: { id: `thread-${created.id}`, spaceId, userId, botId: created.id },
    });
    return created;
  }
  async function run(
    botId: string,
    userId: string,
    input: {
      pin: typeof gpt;
      status: "completed" | "failed";
      tools?: string[];
      tokens?: number;
      cost?: number;
      error?: string;
      prompt?: string;
    },
  ) {
    const threadId = `thread-${botId}`;
    const startedAt = tick();
    const completedAt = tick();
    const task = await prisma.task.create({
      data: {
        spaceId,
        botId,
        threadId,
        userId,
        prompt: input.prompt ?? "Fix the build",
        status: "done",
      },
    });
    const message = await prisma.message.create({
      data: {
        threadId,
        seq: next(),
        role: "user",
        origin: "human-typed",
        actorId: userId,
        blocks: [{ kind: "text", text: input.prompt ?? "Fix the build" }],
      },
    });
    const created = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: input.status,
        trigger: "user",
        sourceMessageId: message.id,
        runtimePin: input.pin,
        error: input.error ?? null,
        startedAt,
        completedAt,
      },
    });
    for (const name of input.tools ?? [])
      await prisma.event.create({
        data: {
          spaceId,
          threadId,
          botId,
          seq: next(),
          type: "agent.tool.called",
          runId: created.id,
          payload: { name, executionId: `exec-${seq}` },
        },
      });
    if (input.tokens !== undefined)
      await prisma.usageRecord.create({
        data: {
          spaceId,
          userId,
          botId,
          runId: created.id,
          provider: input.pin.provider,
          model: input.pin.modelId,
          inputTokens: input.tokens - 1000,
          outputTokens: 1000,
          ...(input.cost !== undefined
            ? {
                cost: input.cost,
                pricingProvenance: { kind: "rate-card", source: "fixture", date: "2026-09-01" },
              }
            : {}),
        },
      });
    return created;
  }
  async function approve(runId: string, count: number, tool = "notion_update_page") {
    for (let i = 0; i < count; i += 1)
      await prisma.externalEffect.create({
        data: {
          spaceId,
          runId,
          kind: tool,
          idempotencyKey: `approval-${suffix}-${next()}`,
          status: "approved",
          request: {},
          decision: "allow",
          decisionByUserId: ownerId,
          decisionAt: new Date(),
        },
      });
  }

  let coderId = "";
  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    const now = new Date();
    for (const id of [ownerId, memberId])
      await prisma.user.create({ data: { id, name: id, email: `${id}@ardurbot.test` } });
    await prisma.organization.create({
      data: { id: organizationId, name: "Insights", slug: organizationId, createdAt: now },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Insights" } });
    for (const [userId, role] of [
      [ownerId, "owner"],
      [memberId, "member"],
    ] as const) {
      await prisma.member.create({
        data: { id: `member-${userId}`, organizationId, userId, role, createdAt: now },
      });
      await prisma.spaceMember.upsert({
        where: { spaceId_userId: { spaceId, userId } },
        create: {
          id: `space-member-${userId}`,
          spaceId,
          organizationId,
          userId,
          role,
          createdAt: now,
        },
        update: { role },
      });
    }
    for (const [userId, credential] of [
      [ownerId, gpt],
      [ownerId, sonnet],
      [memberId, llama],
    ] as const) {
      await prisma.userModelCredential.create({
        data: {
          id: credential.credentialId,
          userId,
          provider: credential.provider,
          label: credential.provider,
          secretId: `secret-${credential.credentialId}`,
        },
      });
      await prisma.spaceModelPreference.create({
        data: { spaceId, userId, credentialId: credential.credentialId },
      });
    }

    // Owner: coding on GPT fails often; the same work on Sonnet mostly finishes.
    const coder = await bot(ownerId, "Coder", gpt);
    coderId = coder.id;
    const reviewer = await bot(ownerId, "Reviewer", sonnet);
    for (let i = 0; i < 4; i += 1)
      await run(coder.id, ownerId, {
        pin: gpt,
        status: "failed",
        tools: ["shell"],
        error: "Build broke",
      });
    for (let i = 0; i < 3; i += 1)
      await run(coder.id, ownerId, {
        pin: gpt,
        status: "completed",
        tools: ["shell"],
        tokens: 40_000,
      });
    await run(reviewer.id, ownerId, { pin: sonnet, status: "failed", tools: ["write_file"] });
    for (let i = 0; i < 9; i += 1)
      await run(reviewer.id, ownerId, {
        pin: sonnet,
        status: "completed",
        tools: ["write_file", "shell"],
        tokens: 20_000,
        cost: 0.25,
      });
    // Repeated work and repeated approvals.
    const prompts = [
      "Summarize open PRs for 21 September",
      "summarize open PRs for 22 September",
      "Summarize open PRs for 23 September",
    ];
    let last = "";
    for (const prompt of prompts)
      last = (await run(coder.id, ownerId, { pin: gpt, status: "completed", tools: [], prompt }))
        .id;
    await approve(last, 5);
    // Personal memory without memory search, and thumbs with reasons while Learning is off.
    for (let i = 0; i < 51; i += 1)
      await prisma.memoryDocument.create({
        data: {
          spaceId,
          userId: ownerId,
          scope: "user",
          path: `notes/${i}.md`,
          content: "A fact.",
        },
      });
    for (let i = 0; i < 3; i += 1) {
      const message = await prisma.message.create({
        data: { threadId: `thread-${coder.id}`, seq: next(), role: "bot", blocks: [] },
      });
      await prisma.feedback.create({
        data: {
          spaceId,
          threadId: `thread-${coder.id}`,
          messageId: message.id,
          runId: last,
          actorId: ownerId,
          rating: "negative",
          reason: "Too long",
        },
      });
    }

    // Member: a local model that keeps running out of context. Owner rows must never leak here.
    const local = await bot(memberId, "Local", llama);
    for (let i = 0; i < 5; i += 1)
      await run(local.id, memberId, {
        pin: llama,
        status: "failed",
        error: "This model's maximum context length is 8192 tokens",
      });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.userModelCredential.deleteMany({ where: { userId: { in: [ownerId, memberId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("aggregates only the person's own tools, usage, feedback, approvals and memory", async () => {
    const facts = await loadInsightFacts(prisma, owner, { owner: true, learningEnabled: false });
    expect(facts.runs).toHaveLength(20);
    expect(facts.runs.every((run) => run.botId !== undefined)).toBe(true);
    const sonnetRun = facts.runs.find(
      (run) => run.pin?.modelId === "claude-sonnet-4-5" && run.status === "completed",
    );
    expect(sonnetRun).toMatchObject({
      tokens: 20_000,
      cost: 0.25,
      tools: expect.arrayContaining(["shell", "write_file"]),
    });
    expect(facts.runs.find((run) => run.pin?.modelId === "gpt-4.1" && run.tokens)?.cost).toBeNull();
    expect(facts.memory).toEqual({ documents: 51, bytes: 51 * 7, semantic: false });
    expect(facts.feedbackReasons).toBe(3);
    expect(facts.approvals).toHaveLength(5);
    expect(facts.prompts).toHaveLength(20);
    expect(facts.credentials.map((c) => c.provider).sort()).toEqual(["anthropic", "openai"]);
    expect(Object.values(facts.models).every((model) => model.available)).toBe(true);
    const memberFacts = await loadInsightFacts(prisma, member, {
      owner: false,
      learningEnabled: false,
    });
    expect(memberFacts.runs).toHaveLength(5);
    expect(memberFacts.approvals).toEqual([]);
    expect(memberFacts.memory.semantic).toBe(true);
  });

  it("stores and lists insights per person; setup insights only for the owner", async () => {
    await refreshLearningInsights(prisma, owner);
    await refreshLearningInsights(prisma, member);
    const mine = await listLearningInsights(prisma, owner);
    expect(mine.map((insight) => insight.evidence.kind).sort()).toEqual([
      "approval",
      "learning-off",
      "memory-search",
      "model-choice",
      "routine",
    ]);
    const choice = mine.find((insight) => insight.evidence.kind === "model-choice")!;
    expect(choice).toMatchObject({
      botId: coderId,
      action: { kind: "bot-model", botId: coderId },
      evidence: { taskKind: "coding", variant: "completion", runs: 17 },
    });
    expect(
      (await listLearningInsights(prisma, owner, coderId)).every((i) => i.botId === coderId),
    ).toBe(true);

    const theirs = await listLearningInsights(prisma, member);
    expect(theirs.map((insight) => insight.evidence)).toEqual([
      expect.objectContaining({ kind: "repeated-failure", failure: "context", streak: 5 }),
    ]);
    await expect(
      settleLearningInsight(prisma, member, choice.id, "dismissed"),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      listLearningInsights(prisma, { spaceId, userId: `stranger-${suffix}` }),
    ).rejects.toBeInstanceOf(IsolationError);

    // Ownership is checked when listing, not only when computing.
    await prisma.spaceMember.update({
      where: { spaceId_userId: owner },
      data: { role: "member" },
    });
    const demoted = await listLearningInsights(prisma, owner);
    expect(demoted.map((insight) => insight.evidence.kind)).not.toContain("memory-search");
    const setup = mine.find((insight) => insight.evidence.kind === "memory-search")!;
    await expect(
      settleLearningInsight(prisma, owner, setup.id, "dismissed"),
    ).rejects.toBeInstanceOf(IsolationError);
    await prisma.spaceMember.update({ where: { spaceId_userId: owner }, data: { role: "owner" } });
  });

  it("keeps a dismissal until the count doubles, and expires what no longer holds", async () => {
    const approval = (await listLearningInsights(prisma, owner)).find(
      (insight) => insight.evidence.kind === "approval",
    )!;
    await settleLearningInsight(prisma, owner, approval.id, "dismissed");
    await refreshLearningInsights(prisma, owner);
    expect((await listLearningInsights(prisma, owner)).map((i) => i.id)).not.toContain(approval.id);

    const runId = (
      await prisma.run.findFirstOrThrow({ where: { botId: coderId, status: "completed" } })
    ).id;
    await approve(runId, 5);
    await refreshLearningInsights(prisma, owner);
    const reopened = (await listLearningInsights(prisma, owner)).find((i) => i.id === approval.id);
    expect(reopened?.evidence).toMatchObject({ kind: "approval", approvals: 10 });

    await prisma.externalEffect.deleteMany({ where: { spaceId, kind: "notion_update_page" } });
    await refreshLearningInsights(prisma, owner);
    expect(
      await prisma.learningInsight.findUniqueOrThrow({ where: { id: approval.id } }),
    ).toMatchObject({
      status: "expired",
    });
  });

  it("drops cleared requests and deleted bots, and reopens rows from an older evidence shape", async () => {
    const routine = (await listLearningInsights(prisma, owner)).find(
      (insight) => insight.evidence.kind === "routine",
    )!;
    const { fingerprint } = await prisma.learningInsight.findUniqueOrThrow({
      where: { id: routine.id },
    });
    await prisma.learningInsight.update({
      where: { id: routine.id },
      data: { evidence: { kind: "routine", shape: "older" } },
    });
    await refreshLearningInsights(prisma, owner);
    const rows = await prisma.learningInsight.findMany({ where: { ...owner, fingerprint } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: routine.id, status: "active", evidence: { count: 3 } });

    const temporary = await bot(ownerId, "Temporary", gpt);
    await prisma.learningInsight.create({
      data: {
        ...owner,
        botId: temporary.id,
        kind: "routine",
        fingerprint: `routine:deleted-${suffix}`,
        status: "dismissed",
        evidence: { kind: "routine", botName: "Temporary", prompt: "Private", count: 3, days: 14 },
        action: { kind: "routine", botId: temporary.id, prompt: "Private" },
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.bot.delete({ where: { id: temporary.id } });
    await refreshLearningInsights(prisma, owner);
    expect(await prisma.learningInsight.count({ where: { botId: temporary.id } })).toBe(0);

    // Clearing the thread deletes its messages; those requests no longer count, and the
    // expired routine insight does not keep their text.
    await prisma.message.deleteMany({ where: { threadId: `thread-${coderId}` } });
    await refreshLearningInsights(prisma, owner);
    expect(await prisma.learningInsight.count({ where: { ...owner, fingerprint } })).toBe(0);
  });

  it("shows nothing and computes nothing while the owner has insights turned off", async () => {
    await prisma.spaceLearningConfig.create({
      data: { spaceId, configuredBy: ownerId, insightsEnabled: false },
    });
    expect(await listLearningInsights(prisma, owner)).toEqual([]);
    await refreshLearningInsights(prisma, owner);
    expect(await prisma.learningInsight.count({ where: { ...owner, status: "active" } })).toBe(0);
  });
});
