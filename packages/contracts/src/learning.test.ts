import { expect, it } from "vitest";
import { LearningCandidateSchema } from "./learning.js";

const candidate = {
  type: "board-item",
  scope: { spaceId: "space", userId: "user", botId: "bot" },
  target: {},
  boardItem: {
    title: "Track recurring failure",
    description: "The same integration failed across runs.",
    acceptanceCriteria: "The failure is fixed and covered by a regression test.",
  },
  rationale: "This follow-up remains unfinished.",
  evidenceIds: ["run-a", "run-b"],
  confidence: { label: "model estimate", value: 0.8 },
};

it("accepts a bounded board-item payload and rejects empty or oversized titles", () => {
  expect(LearningCandidateSchema.parse(candidate).boardItem?.title).toBe("Track recurring failure");
  expect(
    LearningCandidateSchema.safeParse({
      ...candidate,
      boardItem: { ...candidate.boardItem, title: "" },
    }).success,
  ).toBe(false);
  expect(
    LearningCandidateSchema.safeParse({
      ...candidate,
      boardItem: { ...candidate.boardItem, title: "x".repeat(201) },
    }).success,
  ).toBe(false);
});
