import type { GoalConditionSupport } from "@ardurbot/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const submitGoalFromCoordinator = vi.hoisted(() => vi.fn());
const proposeGoalConditionSupport = vi.hoisted(() => vi.fn());
vi.mock("@ardurbot/db", () => ({ submitGoalFromCoordinator, proposeGoalConditionSupport }));

import { reportGoalDone } from "./report-goal-done.js";

const input = {
  goalId: "goal-1",
  spaceId: "space-1",
  userId: "owner-1",
  coordinatorBotId: "bot-1",
  threadId: "thread-1",
  summary: "  The reviewed wording is ready.  ",
};

const proposals: readonly {
  conditionId: string;
  support: readonly GoalConditionSupport[];
}[] = [
  {
    conditionId: "cond-final",
    support: [{ kind: "artifact", recordId: "artifact-1", revision: "a".repeat(64) }],
  },
  {
    conditionId: "cond-final",
    support: [{ kind: "artifact", recordId: "foreign-artifact", revision: "d".repeat(64) }],
  },
];

describe("coordinator goal submission", () => {
  beforeEach(() => {
    submitGoalFromCoordinator.mockReset();
    submitGoalFromCoordinator.mockResolvedValue({ id: "revision-1" });
    proposeGoalConditionSupport.mockReset();
    proposeGoalConditionSupport.mockResolvedValue({ id: "revision-1" });
  });

  it("submits the coordinator summary through the home path", async () => {
    await expect(reportGoalDone({} as never, input)).resolves.toEqual({
      ok: true,
      revisionId: "revision-1",
      status: "completed",
    });
    expect(submitGoalFromCoordinator).toHaveBeenCalledTimes(1);
    expect(submitGoalFromCoordinator).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ summary: "The reviewed wording is ready.", goalId: "goal-1" }),
    );
  });

  it("does not submit a blank report", async () => {
    await expect(reportGoalDone({} as never, { ...input, summary: "   " })).resolves.toEqual({
      ok: false,
      error: "finish_goal requires a summary",
    });
    expect(submitGoalFromCoordinator).not.toHaveBeenCalled();
  });

  it("proposes per-condition support with the run identity after submission", async () => {
    await expect(reportGoalDone({} as never, { ...input, support: proposals })).resolves.toEqual({
      ok: true,
      revisionId: "revision-1",
      status: "completed",
    });
    // The summary submission never carries model-supplied support fields.
    expect(submitGoalFromCoordinator).toHaveBeenCalledWith(
      {},
      expect.not.objectContaining({ support: expect.anything() }),
    );
    expect(proposeGoalConditionSupport).toHaveBeenCalledTimes(2);
    expect(proposeGoalConditionSupport).toHaveBeenNthCalledWith(
      1,
      {},
      {
        goalId: "goal-1",
        spaceId: "space-1",
        userId: "owner-1",
        coordinatorBotId: "bot-1",
        threadId: "thread-1",
        revisionId: "revision-1",
        conditionId: "cond-final",
        support: [{ kind: "artifact", recordId: "artifact-1", revision: "a".repeat(64) }],
      },
    );
  });

  it("drops an invalid proposal without failing the report", async () => {
    proposeGoalConditionSupport.mockRejectedValueOnce(new Error("isolation"));
    await expect(reportGoalDone({} as never, { ...input, support: proposals })).resolves.toEqual({
      ok: true,
      revisionId: "revision-1",
      status: "completed",
    });
    expect(proposeGoalConditionSupport).toHaveBeenCalledTimes(2);
  });
});
