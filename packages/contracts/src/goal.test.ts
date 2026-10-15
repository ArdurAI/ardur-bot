import { describe, expect, it } from "vitest";
import { ProductEventSchema } from "./events.js";
import {
  GoalAcceptInputSchema,
  GoalConditionReviewInputSchema,
  GoalConditionSupportSchema,
  GoalPlanStepInputSchema,
  GoalRejectInputSchema,
  GoalStartInputSchema,
  GoalSubmitInputSchema,
  goalBudget,
  goalResultPath,
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
  it("rejects a board link that names only one side", () => {
    expect(
      GoalStartInputSchema.safeParse({
        groupId: "g_1",
        objective: "Ship",
        boardItemId: "board-a",
      }).success,
    ).toBe(false);
    expect(goalResultPath("group", "goal", "revision")).toBe(
      "/app/g/group?goal=goal&revision=revision",
    );
    expect(goalResultPath("group", "goal", "revision")).not.toContain("http");
  });
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

describe("condition support revision formats", () => {
  it.each([
    { kind: "run", revision: "fixture-secret-7k2" },
    { kind: "run", revision: "a".repeat(64) },
    ...["artifact", "tool-result"].flatMap((kind) =>
      [
        null,
        "fixture-secret-7k2",
        "A".repeat(64),
        "a".repeat(63),
        "g".repeat(64),
        `sha256:${"a".repeat(64)}`,
        `${"a".repeat(64)}\n`,
      ].map((revision) => ({ kind, revision })),
    ),
  ])("rejects malformed support $kind / $revision", (link) => {
    expect(GoalConditionSupportSchema.safeParse({ ...link, recordId: "record-1" }).success).toBe(
      false,
    );
  });
  it.each([
    { kind: "run", revision: null },
    { kind: "artifact", revision: "a".repeat(64) },
    { kind: "tool-result", revision: "0123456789abcdef".repeat(4) },
  ])("accepts the stored revision format for $kind", (link) => {
    expect(GoalConditionSupportSchema.parse({ ...link, recordId: "record-1" })).toEqual({
      ...link,
      recordId: "record-1",
    });
    expect(GoalConditionSupportSchema.safeParse({ ...link, recordId: "" }).success).toBe(false);
    expect(
      GoalConditionSupportSchema.safeParse({
        ...link,
        recordId: "record-1",
        note: "fixture-secret-7k2",
      }).success,
    ).toBe(false);
  });
});

describe("plan step identifier boundary", () => {
  const step = {
    id: "draft-1",
    title: "Draft",
    ownerId: "bot-1",
    ownerIsUser: false,
    condition: "Saved",
  };
  it.each(["", "Draft", "has_space", "has space", "-draft", "a".repeat(41), " draft ", "draft\n"])(
    "refuses non-slug identifier %j in both fields",
    (id) => {
      expect(GoalPlanStepInputSchema.safeParse({ ...step, id }).success).toBe(false);
      expect(GoalPlanStepInputSchema.safeParse({ ...step, prerequisiteIds: [id] }).success).toBe(
        false,
      );
    },
  );
  it.each(["a", "0", "draft-1", "a".repeat(40)])("accepts strict slug %s", (id) => {
    expect(GoalPlanStepInputSchema.safeParse({ ...step, id, prerequisiteIds: [id] }).success).toBe(
      true,
    );
  });
});
