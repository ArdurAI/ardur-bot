import { describe, expect, it } from "vitest";
import type { CategorizedMemoryDocument } from "./document-groups";
import {
  groupMemoryDocuments,
  memoryDocumentSummary,
  memoryTopicTitle,
  memoryUpdatedDate,
} from "./document-groups";

function document(
  id: string,
  overrides: Partial<CategorizedMemoryDocument> = {},
): CategorizedMemoryDocument {
  return {
    id,
    documentId: id,
    revision: 1,
    scopeKey: { kind: "user", spaceId: "space", userId: "user" },
    path: `${id}.md`,
    content: "# A topic\n\n- A concise fact.",
    author: { kind: "user" },
    model: null,
    runId: null,
    threadId: null,
    references: [],
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    deletedAt: null,
    delivery: { status: "delivered", generation: 0, provider: null },
    ...overrides,
  };
}

describe("memory document groups", () => {
  it("groups explicit profile and response preferences separately from topics", () => {
    const documents = [
      document("topic", { kind: "topic" }),
      document("profile", { kind: "profile" }),
      document("preferences", { kind: "preferences" }),
    ];
    const groups = groupMemoryDocuments(documents);
    expect(groups.you.map((entry) => entry.id)).toEqual(["preferences", "profile"]);
    expect(groups.topics.map((entry) => entry.id)).toEqual(["topic"]);
    expect(documents[0]?.id).toBe("topic");
  });

  it("does not mistake bot-setting audit documents for response preferences", () => {
    const groups = groupMemoryDocuments([
      document("setting", { path: "preferences/setting.md" }),
      document("skill", { path: "skills/procedure.md" }),
      document("deleted", { deletedAt: "2026-09-24T00:01:00.000Z" }),
      document("legacy"),
    ]);
    expect(groups.you).toEqual([]);
    expect(groups.topics.map((entry) => entry.id)).toEqual(["legacy"]);
  });

  it("orders revisions by their saved update time and formats the persisted UTC date", () => {
    const groups = groupMemoryDocuments([
      document("older", { updatedAt: "2026-09-23T23:00:00.000Z" }),
      document("newer", { updatedAt: "2026-09-24T00:01:00.000Z" }),
    ]);
    expect(groups.topics.map((entry) => entry.id)).toEqual(["newer", "older"]);
    expect(memoryUpdatedDate(groups.topics[0]!.updatedAt, "en-US")).toBe("Sep 24, 2026");
  });

  it("bounds titles and summaries and keeps content as plain text", () => {
    expect(memoryTopicTitle(document("topic"))).toBe("A topic");
    expect(memoryDocumentSummary("# Title\n\n- A concise fact.\nAnother line")).toBe(
      "A concise fact.",
    );
    expect(memoryDocumentSummary("x".repeat(200))).toHaveLength(180);
    expect(memoryDocumentSummary("# Heading only")).toBe("");
    expect(memoryTopicTitle(document("fallback", { content: "No heading" }))).toBe("fallback");
  });
});
