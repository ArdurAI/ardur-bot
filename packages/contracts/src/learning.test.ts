import { expect, it } from "vitest";
import { boardClosingProposal, LearningCandidateSchema } from "./learning.js";

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

it("accepts only labels the board accepts", () => {
  const labelled = (labels: string[]) =>
    LearningCandidateSchema.safeParse({
      ...candidate,
      boardItem: { ...candidate.boardItem, labels },
    }).success;
  expect(labelled(["follow-up", "import"])).toBe(true);
  for (const label of ["bug, flaky", "two\nlines", "carriage\rreturn", "null\0byte", ""])
    expect(labelled([label]), JSON.stringify(label)).toBe(false);
});

it("marks the proposal an action returned as closing when the action says the board close is still running", () => {
  const proposal = {
    ...candidate,
    id: "proposal",
    status: "rejected",
    diff: "",
    expiresAt: "2026-10-25T12:00:00.000Z",
    provenance: {
      runId: "run",
      originatingPin: null,
      reviewerPin: null,
      policyVersion: 1,
    },
  } as never;
  expect(boardClosingProposal({ proposal, code: "board-closing" })).toMatchObject({
    id: "proposal",
    boardClosing: true,
  });
  expect(boardClosingProposal({ proposal })).toBeNull();
});
