import { describe, expect, it } from "vitest";
import { TaskCardRequestSchema, TaskCardSchema, taskCardSentence } from "./delegation.js";

describe("task cards", () => {
  it("validates typed inputs and bounds without accepting admission fields", () => {
    const valid = {
      goal: "Review",
      inputs: [
        { type: "text", text: "Context" },
        { type: "file", artifactId: "artifact" },
        { type: "url", url: "https://example.test/pr/42" },
        { type: "document", documentId: "doc", revision: 2 },
      ],
    };
    expect(TaskCardRequestSchema.parse(valid).deadlineAt).toBeNull();
    for (const patch of [
      { goal: "x".repeat(2001) },
      { doneWhen: Array(11).fill("Check") },
      { snapshot: {} },
      { approvalBoundaries: { scopes: ["all"] } },
      { inputs: [{ type: "file", artifactId: "id", content: "hidden" }] },
      { inputs: [{ type: "url", url: "file:///private" }] },
    ])
      expect(TaskCardRequestSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
  it("renders one plain sentence with an explicit deadline or none", () => {
    const card = {
      goal: "review PR #42\nfor security issues",
      workerBotId: "Reviewer",
      doneWhen: ["the checklist passes"],
      deadlineAt: "2026-09-25T18:00:00.000Z",
    };
    expect(taskCardSentence(card)).toBe(
      "Reviewer: review PR #42 for security issues — done when the checklist passes — by 18:00 UTC",
    );
    expect(taskCardSentence({ ...card, doneWhen: [], deadlineAt: null })).toContain("no deadline");
  });
  it("requires an admitted card envelope", () => {
    expect(TaskCardSchema.safeParse({ goal: "Review" }).success).toBe(false);
  });
});
