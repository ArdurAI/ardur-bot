import { describe, expect, it } from "vitest";
import { previewFromBlocks } from "./thread-listing.js";

describe("previewFromBlocks", () => {
  it("preserves literal URL paths in autolinks", () => {
    expect(previewFromBlocks([{ kind: "text", text: "Open <https://example.test/_draft_>" }])).toBe(
      "Open https://example.test/_draft_",
    );
  });
  it("preserves filenames while removing surrounding Markdown", () => {
    expect(previewFromBlocks([{ kind: "text", text: "Saved **monthly_sales_report.csv**" }])).toBe(
      "Saved monthly_sales_report.csv",
    );
  });
  it("returns the first text block with Markdown stripped", () => {
    expect(
      previewFromBlocks([
        { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
        { kind: "text", text: "Created **Projects-CoS** as a **Project**" },
      ]),
    ).toBe("Created Projects-CoS as a Project");
  });

  it("returns empty when there is no text block", () => {
    expect(previewFromBlocks([{ kind: "steps", steps: [] }])).toBe("");
    expect(previewFromBlocks(undefined)).toBe("");
  });

  it("skips a reasoning summary and previews the reply", () => {
    expect(
      previewFromBlocks([
        { kind: "progress", text: "**Planning the fix**", reasoning: true },
        { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
        { kind: "text", text: "The config is **stale**." },
      ]),
    ).toBe("The config is stale.");
  });

  it("returns empty when the only text is a reasoning summary", () => {
    expect(
      previewFromBlocks([{ kind: "progress", text: "Weighing options.", reasoning: true }]),
    ).toBe("");
  });
});
