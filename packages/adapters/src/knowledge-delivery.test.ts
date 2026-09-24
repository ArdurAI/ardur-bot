import { expect, it } from "vitest";
import { boundedKnowledgeText } from "./knowledge-delivery.js";
import { recalledKnowledgeExposures } from "./memory/run-memory.js";
import { invokedKnowledgeExposures } from "./skill-documents.js";

it("bounds escaped tool envelopes and records the exact delivered memory span", () => {
  const source = '🙂"\\\n'.repeat(5000);
  const wrap = (memory: string) => ({
    ok: true,
    value: [{ memory, provenance: "[ardur-memory:doc:3]" }],
  });
  const delivered = boundedKnowledgeText(source, wrap);
  expect(JSON.stringify(wrap(delivered)).length).toBeLessThanOrEqual(12000);
  expect(delivered).not.toBe(source);
  expect(Buffer.from(delivered, "utf8").toString("utf8")).toBe(delivered);
  expect(
    recalledKnowledgeExposures(
      [{ memory: delivered, provenance: "[ardur-memory:doc:3]", score: 1, truncated: true }],
      "read",
    ),
  ).toEqual([
    { documentId: "doc", activeRevision: 3, content: delivered, kind: "read", truncated: true },
  ]);
});

it("records only the forced expansion when a prompt also contains routine mentions", () => {
  const skills = ["First", "Second"].map((name) => ({
    name,
    description: name,
    content: `${name} body`,
    source: "user" as const,
    readOnly: false,
    documentId: name,
    activeRevision: 2,
  }));
  expect(invokedKnowledgeExposures("/First\nThen @Second", skills, undefined)).toEqual([
    { documentId: "First", activeRevision: 2, content: "First body", kind: "invoked" },
  ]);
  expect(invokedKnowledgeExposures("Run @First, then @Second", skills, undefined)).toHaveLength(2);
});
