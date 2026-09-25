import { expect, it } from "vitest";
import { briefModelInput } from "./maintenance.js";
import { appendBriefToolResult } from "./tool-results.js";

it("keeps a bounded, redacted text record and omits media bytes", () => {
  let recorded = "";
  for (let index = 0; index < 10; index++)
    recorded = appendBriefToolResult(
      recorded,
      "read_document",
      {
        content: [
          { type: "text", text: "fixture-secret " + "fact ".repeat(1000) },
          { type: "image", data: "image-bytes" },
        ],
      },
      ["fixture-secret"],
    );
  expect(recorded.length).toBeLessThanOrEqual(6000);
  expect(recorded).toContain("[redacted]");
  expect(recorded).not.toContain("fixture-secret");
  expect(recorded).not.toContain("image-bytes");
});
it("keeps the maintenance request valid JSON and preserves structured acceptance state within its budget", () => {
  const prompt = briefModelInput(
    {
      current: '"'.repeat(6000),
      messages: '"'.repeat(16000),
      toolResults: "tool result".repeat(2000),
      summary: "summary".repeat(4000),
      cards: [
        {
          id: "task",
          status: "completed",
          acceptedAt: null,
          card: { goal: "Review the artifact", artifacts: ["artifact"] },
        },
      ],
      threadId: "thread",
      taskId: "root",
    },
    [],
  );
  expect(prompt.length).toBeLessThanOrEqual(30000);
  expect(JSON.parse(prompt).taskCards[0]).toMatchObject({
    status: "completed",
    acceptedAt: null,
    artifacts: ["artifact"],
  });
});
