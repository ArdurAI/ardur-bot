import { describe, expect, it } from "vitest";
import { ProductEventSchema } from "./events.js";
import {
  GoalAcceptInputSchema,
  GoalConditionReviewInputSchema,
  GoalRejectInputSchema,
  GoalSubmitInputSchema,
  goalBudget,
} from "./goal.js";

describe("goal admission budget projection", () => {
  it("keeps used and reserved separate and uses the effective limit", () => {
    expect(goalBudget(100, { usedTokens: 10, reservedTokens: 20, tokenLimit: 90 }, true)).toEqual({
      usedTokens: 10,
      reservedTokens: 20,
      availableTokens: 60,
      usageComplete: true,
    });
  });
  it("never exposes negative available tokens, including late measured usage", () => {
    expect(
      goalBudget(100, { usedTokens: 110, reservedTokens: 20, tokenLimit: 100 }, false),
    ).toEqual({
      usedTokens: 110,
      reservedTokens: 20,
      availableTokens: 0,
      usageComplete: false,
    });
  });
  it("does not turn a missing ledger into a measured zero or an unused allowance", () => {
    expect(goalBudget(100, null, true)).toEqual({
      usedTokens: null,
      reservedTokens: null,
      availableTokens: null,
      usageComplete: false,
    });
  });
});

describe("Goal contracts and state machine", () => {
  it("validates valid submit, accept and reject schemas", () => {
    expect(GoalSubmitInputSchema.safeParse({ goalId: "g_1", summary: "done" }).success).toBe(true);
    expect(GoalAcceptInputSchema.safeParse({ goalId: "g_1", revisionId: "r_1" }).success).toBe(
      true,
    );
    expect(
      GoalRejectInputSchema.safeParse({ goalId: "g_1", revisionId: "r_1", reworkNotes: "fix" })
        .success,
    ).toBe(true);
    expect(
      GoalConditionReviewInputSchema.safeParse({
        goalId: "g_1",
        revisionId: "r_1",
        conditionId: "cond-final",
        status: "pass",
      }).success,
    ).toBe(true);
  });
});

it.each(["goal.submitted", "goal.accepted", "goal.rejected"])(
  "validates the %s product event",
  (type) => {
    expect(
      ProductEventSchema.safeParse({
        id: "event-1",
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq: 1,
        createdAt: "2030-01-01T00:00:00.000Z",
        type,
        payload: { goalId: "goal-1", revisionId: "revision-1" },
      }).success,
    ).toBe(true);
  },
);
