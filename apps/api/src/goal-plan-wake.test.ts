import { runContinueJob } from "@ardurbot/adapter-kit";
import { GOAL_MAX_DEPTH, GOAL_MAX_HOPS } from "@ardurbot/contracts";
import { RPCHandler } from "@orpc/server/fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const settleGoalPlanStep = vi.hoisted(() => vi.fn());
const recordGoalPlanStepOutcome = vi.hoisted(() => vi.fn());
vi.mock("@ardurbot/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ardurbot/db")>()),
  settleGoalPlanStep,
  recordGoalPlanStepOutcome,
}));

const goal = {
  id: "goal-1",
  spaceId: "space-1",
  groupId: "group-1",
  threadId: "thread-1",
  coordinatorBotId: "bot-chief",
  rootTaskId: "task-root",
  objective: "Ship the report",
  doneWhen: ["Report accepted"],
  status: "running",
  tokenLimit: 600_000,
  usedTokens: 0,
  reservedTokens: 0,
  availableTokens: 600_000,
  usageComplete: true,
  perWorkerTokens: 30_000,
  maxConcurrent: 2,
  maxDescendants: 60,
  maxDepth: GOAL_MAX_DEPTH,
  maxHops: GOAL_MAX_HOPS,
  untilAt: "2030-01-02T00:00:00.000Z",
  createdAt: "2030-01-01T00:00:00.000Z",
  stoppedAt: null,
  plan: { revision: 4, steps: [] },
};

describe("goal plan step RPCs", () => {
  beforeEach(() => {
    settleGoalPlanStep.mockReset();
    recordGoalPlanStepOutcome.mockReset();
  });

  it.each([
    [
      "planStep",
      "cancel",
      { goalId: "goal-1", stepId: "step-a", baseRevision: 3, action: "cancel" },
    ],
    [
      "planOutcome",
      "done",
      { goalId: "goal-1", stepId: "step-a", baseRevision: 3, support: [] },
    ],
  ] as const)("enqueues the coordinator wake after the owner marks a step %s", async (operation, _action, input) => {
    settleGoalPlanStep.mockResolvedValue(goal);
    recordGoalPlanStepOutcome.mockResolvedValue(goal);
    const findUnique = vi.fn(async () => ({ id: "wake-run", status: "queued" }));
    const enqueue = vi.fn(async () => undefined);
    const router = createRouter({
      prisma: { run: { findUnique } },
      env: { sandboxProvider: "fake" },
      jobs: { enqueue },
    } as unknown as RouterDeps);
    const context = {
      actor: {
        spaceId: "space-1",
        userId: "owner-1",
        email: "owner@example.test",
        isDeploymentOwner: true,
      },
      authSessionId: "session-1",
    };
    const handler = new RPCHandler(router);
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/goals/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context },
    );
    if (response?.status !== 200)
      console.log(operation, await response?.text());
    expect(response?.status).toBe(200);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId_clientNonce: { spaceId: "space-1", clientNonce: "goal-plan:goal-1:4" },
        },
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(runContinueJob("wake-run"));
  });
});
