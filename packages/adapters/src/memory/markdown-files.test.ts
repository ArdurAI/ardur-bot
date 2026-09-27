import type { DocumentRevision, ImportedProvenance } from "@ardurbot/contracts";
import { MemoryRedactionError } from "@ardurbot/memory";
import { describe, expect, it } from "vitest";
import { parseRevisionMarkdown, revisionMarkdown } from "./markdown-files.js";

const provenance: ImportedProvenance = {
  tool: "codex",
  relativePath: "instructions/workflow.md",
  sourcePathHash: "0".repeat(64),
  contentHash: "1".repeat(64),
  modifiedAt: "2026-09-23T12:00:00.000Z",
  importedAt: "2026-09-23T12:00:00.000Z",
  kind: "instructions",
  authorizesIntent: false,
};

const baseRevision: DocumentRevision = {
  documentId: "doc-1",
  revision: 1,
  scopeKey: { kind: "space-shared", spaceId: "space-a" },
  path: "workflow.md",
  content: "# Workflow\n\nContent here.\n",
  author: { kind: "user", userId: "user-1" },
  model: null,
  runId: null,
  threadId: null,
  references: [],
  createdAt: "2026-09-23T12:00:00.000Z",
  deletedAt: null,
};

describe("revisionMarkdown and parseRevisionMarkdown", () => {
  it("serializes and round-trips imported provenance", () => {
    const revision: DocumentRevision = { ...baseRevision, imported: provenance };
    const text = revisionMarkdown(revision);
    expect(text).toContain("imported:");
    const parsed = parseRevisionMarkdown(text);
    expect(parsed.imported).toEqual(provenance);
    expect(parsed).toEqual(revision);
  });

  it("omits imported field when not present and keeps parsing older notes", () => {
    const text = revisionMarkdown(baseRevision);
    expect(text).not.toContain("imported:");
    const parsed = parseRevisionMarkdown(text);
    expect(parsed.imported).toBeUndefined();
    expect(parsed).toEqual(baseRevision);
  });

  it("rejects invalid imported metadata schema", () => {
    const text = `---\nid: "doc-1"\nscope: {"kind":"space-shared","spaceId":"space-a"}\nauthor: {"kind":"user","userId":"user-1"}\nimported: {"tool":"invalid-tool"}\nrevision: 1\nupdatedAt: "2026-09-23T12:00:00.000Z"\npath: "workflow.md"\ndeletedAt: null\n---\n# Workflow\n`;
    expect(() => parseRevisionMarkdown(text)).toThrow();
  });

  it("rejects secret-shaped metadata in imported provenance", () => {
    const fakeKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0";
    const text = `---\nid: "doc-1"\nscope: {"kind":"space-shared","spaceId":"space-a"}\nauthor: {"kind":"user","userId":"user-1"}\nimported: {"tool":"codex","relativePath":"${fakeKey}","sourcePathHash":"${"a".repeat(64)}","contentHash":"${"b".repeat(64)}","modifiedAt":"2026-09-23T12:00:00.000Z","importedAt":"2026-09-23T12:00:00.000Z","kind":"instructions","authorizesIntent":false}\nrevision: 1\nupdatedAt: "2026-09-23T12:00:00.000Z"\npath: "workflow.md"\ndeletedAt: null\n---\n# Workflow\n`;
    expect(() => parseRevisionMarkdown(text)).toThrow(MemoryRedactionError);
  });
});
