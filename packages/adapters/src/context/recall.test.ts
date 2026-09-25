import type { MemoryStore } from "@ardurbot/adapter-kit";
import { expect, it, vi } from "vitest";
import { assembleTurnContext } from "./assemble.js";
import { fitContextRecall, recallLocalDocuments } from "./recall.js";

it("retrieves relevant local documents with revision citations and excludes procedures", async () => {
  const read = vi.fn(async ({ scope }) => ({
    documents:
      scope === "bot"
        ? [
            { id: "launch", path: "facts/launch.md", content: "launch Friday", revision: 4 },
            { id: "skill", path: "skills/launch.md", content: "launch procedure", revision: 1 },
            { id: "unrelated", path: "facts/menu.md", content: "lunch menu", revision: 1 },
          ]
        : [],
  }));
  const results = await recallLocalDocuments(
    { read } as unknown as MemoryStore,
    "chief",
    "launch",
    {
      spaceId: "space",
      userId: "owner",
      operationId: "recall",
      traceId: "recall",
      signal: new AbortController().signal,
    },
  );
  expect(results).toEqual([
    {
      id: "launch",
      memory: "launch Friday",
      score: 1,
      provenance: "[ardur-memory:launch:4]",
      updatedAt: undefined,
    },
  ]);
});
it("records exactly the recalled bytes delivered after escaping and budgeting", async () => {
  const fitted = fitContextRecall(
    [
      {
        id: "document",
        score: 1,
        provenance: "[ardur-memory:document:2]",
        memory: "<fact>&".repeat(2000),
      },
    ],
    6000,
    [],
  );
  const result = await assembleTurnContext({
    instructions: "Rules",
    history: [],
    message: "What was the fact?",
    recall: async () => fitted.text,
  });
  expect(result.snapshot.layers.recall).toBeLessThanOrEqual(6000);
  expect(result.history[0]?.content).toContain("[ardur-memory:document:2]");
  expect(result.history[0]?.content).toContain(
    fitted.results[0]!.memory.replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;"),
  );
  expect(fitted.results[0]?.truncated).toBe(true);
  const recall = vi.fn(async () => "ignored");
  await assembleTurnContext({
    instructions: "Rules",
    history: [],
    brief: "deadline Friday",
    query: "What is the deadline?",
    message: "What is the deadline? Current time and workspace context",
    recall,
  });
  expect(recall).not.toHaveBeenCalled();
});
