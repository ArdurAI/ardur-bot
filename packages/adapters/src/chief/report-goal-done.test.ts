import { beforeEach, describe, expect, it, vi } from "vitest";

const submitGoalFromCoordinator = vi.hoisted(() => vi.fn());
vi.mock("@ardurbot/db", () => ({ submitGoalFromCoordinator }));

import { reportGoalDone } from "./report-goal-done.js";

const input = {
  goalId: "goal-1",
  spaceId: "space-1",
  userId: "owner-1",
  coordinatorBotId: "bot-1",
  threadId: "thread-1",
  summary: "  The reviewed wording is ready.  ",
};

describe("coordinator goal submission", () => {
  beforeEach(() => {
    submitGoalFromCoordinator.mockReset();
    submitGoalFromCoordinator.mockResolvedValue({ id: "revision-1" });
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
});
