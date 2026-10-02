import { describe, expect, it } from "vitest";
import { refusedDocumentDigest } from "./document-store-factory.js";

describe("refused memory document log identifier", () => {
  it("never contains the id it names, and is stable for matching repeated warnings", () => {
    const id = "doc-live-value-9f8e7d6c";
    const digest = refusedDocumentDigest(id);
    expect(digest).toMatch(/^[a-f0-9]{12}$/);
    expect(digest).not.toContain("9f8e7d6c");
    expect(refusedDocumentDigest(id)).toBe(digest);
    expect(refusedDocumentDigest("doc-other")).not.toBe(digest);
  });
});
