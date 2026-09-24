import { describe, expect, it } from "vitest";
import { ComparisonMergeSchema, ComparisonStartSchema } from "./comparison.js";

const input = {
  coordinatorBotId: "a",
  participantBotIds: ["a", "b"],
  text: "One task",
  clientNonce: "request",
};
describe("comparison requests", () => {
  it("requires two to four unique bots including the current bot", () => {
    expect(ComparisonStartSchema.parse(input).reserveMerge).toBe(true);
    for (const participantBotIds of [["a"], ["a", "a"], ["b", "c"], ["a", "b", "c", "d", "e"]])
      expect(ComparisonStartSchema.safeParse({ ...input, participantBotIds }).success).toBe(false);
  });
  it("accepts one source only and rejects caller-supplied orchestration fields", () => {
    expect(ComparisonStartSchema.safeParse({ ...input, delegationId: "card" }).success).toBe(false);
    expect(
      ComparisonStartSchema.safeParse({ ...input, snapshot: { text: "forged" } }).success,
    ).toBe(false);
    expect(
      ComparisonStartSchema.parse({ ...input, text: undefined, delegationId: "card" }).delegationId,
    ).toBe("card");
  });
  it("does not implicitly buy an unreserved merge or accept duplicate sources", () => {
    expect(
      ComparisonMergeSchema.parse({ id: "comparison", botId: "a", selectedRunIds: ["run"] })
        .reserveBudget,
    ).toBe(false);
    expect(
      ComparisonMergeSchema.safeParse({
        id: "comparison",
        botId: "a",
        selectedRunIds: ["run", "run"],
      }).success,
    ).toBe(false);
  });
});
