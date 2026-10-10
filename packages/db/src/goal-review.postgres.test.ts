import { describe, expect, it } from "vitest";
import { preparePrisma } from "./client.test.js";
import { acceptGoal, rejectGoal, submitGoal } from "./goals.js";

describe("Goal owner review", () => {
  it("submits, reviews, rejects and accepts", async () => {
    const { prisma, ids } = await preparePrisma();

    // Create goal
    const goal = await prisma.teamGoal.create({
      data: {
        id: "test-goal",
        spaceId: ids.space,
        userId: ids.user,
        groupId: ids.group,
        threadId: ids.thread,
        coordinatorBotId: ids.bot,
        rootTaskId: ids.task,
        objective: "test",
        status: "running",
        tokenLimit: 100,
        perWorkerTokens: 10,
        maxConcurrent: 1,
        maxDescendants: 1,
        untilAt: new Date(),
        maxDepth: 1,
        maxHops: 1,
      },
    });

    const actor = {
      spaceId: ids.space,
      userId: ids.user,
      isDeploymentOwner: true,
      kind: "human",
      id: ids.user,
    } as const;

    // submit
    const rev1 = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "First attempt",
      artifacts: [],
      reports: [],
    });

    expect(rev1.summary).toBe("First attempt");
    expect(rev1.attempts).toBe(1);

    const afterSubmit = await prisma.teamGoal.findUnique({ where: { id: goal.id } });
    expect(afterSubmit?.status).toBe("completed");

    // reject
    const verdict1 = await rejectGoal(prisma, actor, {
      goalId: goal.id,
      revisionId: rev1.id,
      reworkNotes: "Do better",
    });
    expect(verdict1.type).toBe("reject");

    const afterReject = await prisma.teamGoal.findUnique({ where: { id: goal.id } });
    expect(afterReject?.status).toBe("running");

    // submit again
    const rev2 = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Second attempt",
      artifacts: [],
      reports: [],
    });
    expect(rev2.attempts).toBe(2);

    // accept
    const verdict2 = await acceptGoal(prisma, actor, {
      goalId: goal.id,
      revisionId: rev2.id,
    });
    expect(verdict2.type).toBe("accept");

    const afterAccept = await prisma.teamGoal.findUnique({ where: { id: goal.id } });
    expect(afterAccept?.status).toBe("accepted");
  });
});
