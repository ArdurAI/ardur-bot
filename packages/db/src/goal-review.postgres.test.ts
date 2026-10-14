import type { Actor } from "@ardurbot/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  acceptGoal,
  proposeGoalConditionSupport,
  rejectGoal,
  reviewGoalCondition,
  submitGoal,
  submitGoalFromCoordinator,
} from "./goals.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("Goal owner review (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `goal-review-org-${suffix}`;
  const spaceId = `goal-review-space-${suffix}`;
  const foreignSpaceId = `goal-review-foreign-space-${suffix}`;
  const userId = `goal-review-user-${suffix}`;
  const actor: Actor = { spaceId, userId, email: "owner@example.test", isDeploymentOwner: true };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;
  let workerBotId: string;
  let goalCount = 0;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Goal review fixture",
        slug: organizationId,
        createdAt: new Date(),
        spaces: {
          create: [
            { id: spaceId, name: "Goal review fixture" },
            { id: foreignSpaceId, name: "Goal review foreign fixture" },
          ],
        },
      },
    });
    await prisma.user.create({
      data: { id: userId, name: "Review fixture", email: `${userId}@example.test` },
    });
    await prisma.member.create({
      data: {
        id: `member-${suffix}`,
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: `space-member-${suffix}`,
        organizationId,
        spaceId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const worker = await prisma.bot.create({
      data: { spaceId, userId, name: "Worker fixture", color: "ink" },
    });
    workerBotId = worker.id;
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Goal review fixture", color: "ink" },
    });
    botId = bot.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      // Evidence rows are append-only; the harness drops this database anyway,
      // so allow the fixture cleanup cascade to remove them.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ardur.evidence_delete = 'on'`;
        await tx.organization.delete({ where: { id: organizationId } });
        await tx.user.delete({ where: { id: userId } });
      });
    } finally {
      await close();
    }
  });

  async function createGoal() {
    goalCount += 1;
    const group = await prisma.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: `Goal review fixture ${goalCount}`,
        coordinatorBotId: botId,
      },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
    await prisma.chatGroupMember.createMany({
      data: [botId, workerBotId].map((memberBotId) => ({ groupId: group.id, botId: memberBotId })),
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId: thread.id,
        prompt: "Fixture",
        status: "completed",
      },
    });
    const goal = await prisma.teamGoal.create({
      data: {
        spaceId,
        userId,
        groupId: group.id,
        threadId: thread.id,
        coordinatorBotId: botId,
        rootTaskId: task.id,
        objective: "Review fixture",
        status: "running",
        tokenLimit: 100,
        perWorkerTokens: 10,
        maxConcurrent: 1,
        maxDescendants: 1,
        untilAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.delegationRoot.create({
      data: {
        rootTaskId: task.id,
        spaceId,
        userId,
        coordinatorBotId: botId,
        coordinatorThreadId: thread.id,
        tokenLimit: 100,
        deadlineAt: goal.untilAt,
      },
    });
    return goal;
  }

  it("keeps rejected and accepted submissions unchanged through rework", async () => {
    const goal = await createGoal();
    const submit = (summary: string) =>
      submitGoal(prisma, actor, {
        goalId: goal.id,
        summary,
        artifacts: [],
        reports: [],
      });
    const rev1 = await submit("First attempt");
    const snapshot = await prisma.goalRevision.findUniqueOrThrow({ where: { id: rev1.id } });
    expect(rev1.attempts).toBe(1);
    await expect(submit("Overwrite attempt")).rejects.toThrow("already submitted");
    const feedback = await rejectGoal(prisma, actor, {
      goalId: goal.id,
      revisionId: rev1.id,
      reworkNotes: "Review again",
    });
    expect(feedback.type).toBe("reject");
    const rev2 = await submit("Second attempt");
    expect(rev2.attempts).toBe(2);
    await expect(
      acceptGoal(prisma, actor, {
        goalId: goal.id,
        revisionId: rev1.id,
      }),
    ).rejects.toThrow("not current");
    await reviewGoalCondition(prisma, actor, {
      goalId: goal.id,
      revisionId: rev2.id,
      conditionId: "cond-final",
      status: "pass",
    });
    const verdict = await acceptGoal(prisma, actor, { goalId: goal.id, revisionId: rev2.id });
    expect(verdict.type).toBe("accept");
    await expect(
      rejectGoal(prisma, actor, {
        goalId: goal.id,
        revisionId: rev2.id,
        reworkNotes: "Reopen",
      }),
    ).rejects.toThrow("already reviewed");
    expect(await prisma.goalRevision.findUnique({ where: { id: rev1.id } })).toEqual(snapshot);
    expect((await prisma.teamGoal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
      "accepted",
    );
  });

  it.each(["non-owner", "other-user", "other-space"] as const)(
    "refuses accept and reject from %s",
    async (kind) => {
      const goal = await createGoal();
      const revision = await submitGoal(prisma, actor, {
        goalId: goal.id,
        summary: "Candidate",
        artifacts: [],
        reports: [],
      });
      const outsider = {
        ...actor,
        ...(kind === "non-owner"
          ? { isDeploymentOwner: false }
          : kind === "other-user"
            ? { userId: "other-user" }
            : { spaceId: "other-space" }),
      };
      const input = { goalId: goal.id, revisionId: revision.id };
      await expect(acceptGoal(prisma, outsider, input)).rejects.toThrow();
      await expect(
        rejectGoal(prisma, outsider, { ...input, reworkNotes: "Reopen" }),
      ).rejects.toThrow();
      expect(await prisma.goalVerdict.count({ where: { goalId: goal.id } })).toBe(0);
    },
  );

  it("records one acceptance and event for two owner tabs and a retry", async () => {
    const goal = await createGoal();
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Candidate",
      artifacts: [],
      reports: [],
    });
    const input = { goalId: goal.id, revisionId: revision.id };
    await reviewGoalCondition(prisma, actor, {
      ...input,
      conditionId: "cond-final",
      status: "pass",
    });
    const [first, second] = await Promise.all([
      acceptGoal(prisma, actor, input),
      acceptGoal(prisma, actor, input),
    ]);
    expect(second).toEqual(first);
    expect(await acceptGoal(prisma, actor, input)).toEqual(first);
    expect(await prisma.goalVerdict.count({ where: { goalId: goal.id, type: "accept" } })).toBe(1);
    expect(
      await prisma.event.count({
        where: {
          threadId: goal.threadId,
          type: "goal.accepted",
          payload: { path: ["goalId"], equals: goal.id },
        },
      }),
    ).toBe(1);
  });

  it("submits when the coordinator reports the project done", async () => {
    const goal = await createGoal();
    const revision = await submitGoalFromCoordinator(prisma, {
      goalId: goal.id,
      spaceId,
      userId,
      coordinatorBotId: goal.coordinatorBotId,
      threadId: goal.threadId,
      summary: "Coordinator result",
    });
    expect(revision.summary).toBe("Coordinator result");
    expect(revision.conditions).toEqual([
      expect.objectContaining({ id: "cond-final", status: "unknown" }),
    ]);
    expect((await prisma.teamGoal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
      "completed",
    );
    await expect(
      submitGoalFromCoordinator(prisma, {
        goalId: goal.id,
        spaceId,
        userId,
        coordinatorBotId: "other-bot",
        threadId: goal.threadId,
        summary: "Not the coordinator",
      }),
    ).rejects.toThrow();
    expect(await prisma.goalRevision.count({ where: { goalId: goal.id } })).toBe(1);
  });

  it("refuses acceptance until every condition passes", async () => {
    const goal = await createGoal();
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Candidate",
      artifacts: [],
      reports: [],
    });
    const input = { goalId: goal.id, revisionId: revision.id };
    await expect(acceptGoal(prisma, actor, input)).rejects.toThrow("Every condition must pass");
    await reviewGoalCondition(prisma, actor, {
      ...input,
      conditionId: "cond-final",
      status: "fail",
    });
    await expect(acceptGoal(prisma, actor, input)).rejects.toThrow("Every condition must pass");
    await reviewGoalCondition(prisma, actor, {
      ...input,
      conditionId: "cond-final",
      status: "pass",
    });
    const accepted = await acceptGoal(prisma, actor, input);
    expect(await acceptGoal(prisma, actor, input)).toEqual(accepted);
    expect(await prisma.goalVerdict.count({ where: { goalId: goal.id } })).toBe(1);
  });

  it("wakes the coordinator once with the rework notes", async () => {
    const goal = await createGoal();
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Candidate",
      artifacts: [],
      reports: [],
    });
    const input = { goalId: goal.id, revisionId: revision.id, reworkNotes: "Review again" };
    await rejectGoal(prisma, actor, input);
    await rejectGoal(prisma, actor, input);
    const wakes = await prisma.run.findMany({
      where: { goalId: goal.id, clientNonce: `goal-rework:${revision.id}` },
    });
    expect(wakes).toHaveLength(1);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: wakes[0]!.taskId } });
    expect(task.prompt).toContain("Review again");
    expect((await prisma.teamGoal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
      "running",
    );
  });

  async function createSupportRecords(
    goal: { id: string; threadId: string; coordinatorBotId: string },
    space: string,
    recordUserId = userId,
  ) {
    const task = await prisma.task.create({
      data: {
        spaceId: space,
        userId: recordUserId,
        botId: goal.coordinatorBotId,
        threadId: goal.threadId,
        prompt: "Support fixture",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: space,
        userId: recordUserId,
        botId: goal.coordinatorBotId,
        threadId: goal.threadId,
        taskId: task.id,
        status: "completed",
        trigger: "follow_up",
        goalId: goal.id,
      },
    });
    const record = await prisma.evidenceRecord.create({
      data: {
        spaceId: space,
        runId: run.id,
        seq: 1,
        receiptId: `receipt-${run.id}`,
        kid: "kid-fixture",
        jws: "fixture-jws",
        sha256: "b".repeat(64),
        verdict: "compliant",
        decisionKind: "allowed",
        toolName: "fixture_tool",
      },
    });
    const artifact = await prisma.artifact.create({
      data: {
        spaceId: space,
        userId: recordUserId,
        botId: goal.coordinatorBotId,
        runId: run.id,
        name: "result.md",
        mimeType: "text/markdown",
        size: 10,
        hash: "a".repeat(64),
        storageKey: `storage-${run.id}`,
      },
    });
    return { run, record, artifact };
  }

  it.each(["owner", "coordinator"])(
    "rejects a secret run revision at the %s boundary without storing it",
    async (caller) => {
      const goal = await createGoal();
      const revision = await submitGoal(prisma, actor, {
        goalId: goal.id,
        summary: "Candidate",
        artifacts: [],
        reports: [],
      });
      const { run } = await createSupportRecords(goal, spaceId);
      const input = {
        goalId: goal.id,
        revisionId: revision.id,
        conditionId: "cond-final",
        support: [{ kind: "run", recordId: run.id, revision: "fixture-secret-7k2" }],
      };
      await expect(
        caller === "owner"
          ? reviewGoalCondition(prisma, actor, { ...input, status: "pass" } as never)
          : proposeGoalConditionSupport(prisma, {
              ...input,
              spaceId,
              userId,
              coordinatorBotId: goal.coordinatorBotId,
              threadId: goal.threadId,
            } as never),
      ).rejects.toThrow();
      const stored = await prisma.goalRevision.findUniqueOrThrow({ where: { id: revision.id } });
      expect(stored.conditions).toEqual(revision.conditions);
      expect(JSON.stringify(stored)).not.toContain("fixture-secret-7k2");
    },
  );

  it.each([false, true])(
    "checks tool support against its private run thread (visible=%s)",
    async (visible) => {
      const goal = await createGoal();
      const revision = await submitGoal(prisma, actor, {
        goalId: goal.id,
        summary: "Candidate",
        artifacts: [],
        reports: [],
      });
      const recordUserId = visible ? userId : `other-user-${suffix}`;
      const bot = await prisma.bot.create({
        data: { spaceId, userId: recordUserId, name: "Private fixture", color: "ink" },
      });
      const thread = await prisma.thread.create({
        data: { spaceId, userId: recordUserId, botId: bot.id },
      });
      const { record } = await createSupportRecords(
        { ...goal, coordinatorBotId: bot.id, threadId: thread.id },
        spaceId,
        recordUserId,
      );
      const support = [
        { kind: "tool-result" as const, recordId: record.id, revision: record.sha256 },
      ];
      const attempt = reviewGoalCondition(prisma, actor, {
        goalId: goal.id,
        revisionId: revision.id,
        conditionId: "cond-final",
        status: "pass",
        support,
      });
      if (visible)
        await expect(attempt).resolves.toMatchObject({
          conditions: [expect.objectContaining({ status: "pass", support })],
        });
      else {
        await expect(attempt).rejects.toThrow();
        expect(
          (await prisma.goalRevision.findUniqueOrThrow({ where: { id: revision.id } })).conditions,
        ).toEqual(revision.conditions);
      }
    },
  );

  it("attests supporting records and keeps them in the review snapshot", async () => {
    const goal = await createGoal();
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Candidate",
      artifacts: [],
      reports: [],
    });
    const { run, record, artifact } = await createSupportRecords(goal, spaceId);
    const support = [
      { kind: "artifact" as const, recordId: artifact.id, revision: "a".repeat(64) },
      { kind: "tool-result" as const, recordId: record.id, revision: "b".repeat(64) },
      { kind: "run" as const, recordId: run.id, revision: null },
    ];
    const reviewed = await reviewGoalCondition(prisma, actor, {
      goalId: goal.id,
      revisionId: revision.id,
      conditionId: "cond-final",
      status: "pass",
      support,
    });
    expect(reviewed.conditions[0]).toEqual(expect.objectContaining({ status: "pass", support }));
    const verdict = await acceptGoal(prisma, actor, {
      goalId: goal.id,
      revisionId: revision.id,
    });
    expect(verdict.type).toBe("accept");
    const snapshot = await prisma.goalRevision.findUniqueOrThrow({ where: { id: revision.id } });
    expect(snapshot.conditions).toEqual([
      expect.objectContaining({ status: "pass", actorId: userId, support }),
    ]);
  });

  it.each([
    ["foreign-space", "foreign-space", "a".repeat(64), null],
    ["stale", "same-space", "c".repeat(64), "stale-record"],
    ["missing", "same-space", "a".repeat(64), "missing-record"],
  ])("refuses a %s artifact support link", async (_kind, space, revisionHash, reason) => {
    const goal = await createGoal();
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Candidate",
      artifacts: [],
      reports: [],
    });
    const { artifact } = await createSupportRecords(goal, spaceId);
    if (space === "foreign-space") {
      await prisma.artifact.update({
        where: { id: artifact.id },
        data: { spaceId: foreignSpaceId },
      });
    }
    const recordId =
      space === "same-space" && reason === "missing-record" ? "missing" : artifact.id;
    const attempt = reviewGoalCondition(prisma, actor, {
      goalId: goal.id,
      revisionId: revision.id,
      conditionId: "cond-final",
      status: "pass",
      support: [{ kind: "artifact", recordId, revision: revisionHash }],
    });
    if (reason) await expect(attempt).rejects.toMatchObject({ reason });
    else await expect(attempt).rejects.toThrow();
    const snapshot = await prisma.goalRevision.findUniqueOrThrow({ where: { id: revision.id } });
    expect(snapshot.conditions).toEqual([
      expect.objectContaining({ status: "unknown", support: [] }),
    ]);
  });

  it("refuses a run support link from outside the goal's work", async () => {
    const goal = await createGoal();
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Candidate",
      artifacts: [],
      reports: [],
    });
    const other = await createGoal();
    const { run } = await createSupportRecords(other, spaceId);
    await expect(
      reviewGoalCondition(prisma, actor, {
        goalId: goal.id,
        revisionId: revision.id,
        conditionId: "cond-final",
        status: "pass",
        support: [{ kind: "run", recordId: run.id, revision: null }],
      }),
    ).rejects.toMatchObject({ reason: "run-outside-goal" });
  });

  it("refuses a stale review revision when attesting support", async () => {
    const goal = await createGoal();
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Candidate",
      artifacts: [],
      reports: [],
    });
    await rejectGoal(prisma, actor, {
      goalId: goal.id,
      revisionId: revision.id,
      reworkNotes: "Review again",
    });
    await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Second attempt",
      artifacts: [],
      reports: [],
    });
    await expect(
      reviewGoalCondition(prisma, actor, {
        goalId: goal.id,
        revisionId: revision.id,
        conditionId: "cond-final",
        status: "pass",
        support: [],
      }),
    ).rejects.toThrow("not current");
  });

  it("stores coordinator proposals without recording a verdict", async () => {
    const goal = await createGoal();
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Candidate",
      artifacts: [],
      reports: [],
    });
    const { artifact } = await createSupportRecords(goal, spaceId);
    const proposal = {
      goalId: goal.id,
      spaceId,
      userId,
      coordinatorBotId: goal.coordinatorBotId,
      threadId: goal.threadId,
      revisionId: revision.id,
      conditionId: "cond-final",
      support: [{ kind: "artifact" as const, recordId: artifact.id, revision: "a".repeat(64) }],
    };
    const proposed = await proposeGoalConditionSupport(prisma, proposal);
    expect(proposed.conditions[0]).toEqual(
      expect.objectContaining({
        status: "unknown",
        support: [],
        proposedSupport: proposal.support,
      }),
    );
    // The proposal decided nothing: acceptance still needs the owner's pass.
    await expect(
      acceptGoal(prisma, actor, { goalId: goal.id, revisionId: revision.id }),
    ).rejects.toThrow("Every condition must pass");
    expect(await prisma.goalVerdict.count({ where: { goalId: goal.id } })).toBe(0);
    await expect(
      proposeGoalConditionSupport(prisma, { ...proposal, coordinatorBotId: "other-bot" }),
    ).rejects.toThrow();
    // The owner's review supersedes the proposal.
    const reviewed = await reviewGoalCondition(prisma, actor, {
      goalId: goal.id,
      revisionId: revision.id,
      conditionId: "cond-final",
      status: "pass",
      support: proposal.support,
    });
    expect(reviewed.conditions[0]).toEqual(
      expect.objectContaining({ status: "pass", support: proposal.support, proposedSupport: [] }),
    );
  });

  it("keeps earlier links readable after rework and starts fresh proposals", async () => {
    const goal = await createGoal();
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "First attempt",
      artifacts: [],
      reports: [],
    });
    const { artifact } = await createSupportRecords(goal, spaceId);
    const support = [
      { kind: "artifact" as const, recordId: artifact.id, revision: "a".repeat(64) },
    ];
    await reviewGoalCondition(prisma, actor, {
      goalId: goal.id,
      revisionId: revision.id,
      conditionId: "cond-final",
      status: "fail",
      reason: "Rework this",
      support,
    });
    await rejectGoal(prisma, actor, {
      goalId: goal.id,
      revisionId: revision.id,
      reworkNotes: "Review again",
    });
    const reworked = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Second attempt",
      artifacts: [],
      reports: [],
    });
    expect(reworked.attempts).toBe(2);
    // The new revision starts fresh: no attested links, no proposals.
    expect(reworked.conditions).toEqual([
      expect.objectContaining({ status: "unknown", support: [], proposedSupport: [] }),
    ]);
    // The earlier revision still reads back with the links the owner attested.
    const earlier = await prisma.goalRevision.findUniqueOrThrow({ where: { id: revision.id } });
    expect(earlier.conditions).toEqual([
      expect.objectContaining({ status: "fail", support, proposedSupport: [] }),
    ]);
  });
});
