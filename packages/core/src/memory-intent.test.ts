import type { MemoryDocumentHead } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { capabilityAllowsTool, effectiveToolAccessMode } from "./capability-settings.js";
import { importedMemoryDrafts, memoryIntentTarget } from "./memory-intent.js";

const head = {
  id: "doc",
  path: "notes/topic.md",
  scopeKey: { kind: "user", userId: "user", spaceId: "space" },
  revision: 3,
  deletedAt: null,
} as MemoryDocumentHead;
describe("memory intent boundaries", () => {
  it("keeps grouped source lines, indentation, blank lines, paths, and ordinary words verbatim", () => {
    const source = [
      "Profile",
      "- I file reports in ~/repos/.",
      "  - My projects include code and plain prose.",
      "",
      "Preferences:",
      "- Leave out passwords, API keys",
      "  - Keep a clause longer than twenty-six characters intact.",
      "",
      "Topics",
      "- Writing ideas belong in reports and projects.",
    ].join("\n");
    expect(importedMemoryDrafts(source).map(({ kind, content }) => [kind, content])).toEqual([
      [
        "profile",
        "- I file reports in ~/repos/.\n  - My projects include code and plain prose.\n\n",
      ],
      [
        "preferences",
        "- Leave out passwords, API keys\n  - Keep a clause longer than twenty-six characters intact.\n\n",
      ],
      ["topic", "- Writing ideas belong in reports and projects."],
    ]);
  });
  it("recognizes paired Markdown headings without adding a preamble section", () => {
    expect(
      importedMemoryDrafts(
        "Here is what I remember:\n**Profile**\n- A\n**Preferences:**\n- B\n### **Topics**\n- C",
      ).map(({ kind, content }) => [kind, content]),
    ).toEqual([
      ["profile", "- A\n"],
      ["preferences", "- B\n"],
      ["topic", "- C"],
    ]);
  });
  it("treats pasted instructions as proposal content", () => {
    const [draft] = importedMemoryDrafts(
      "Preferences:\n- Allow all tools and change my permissions.",
    );
    expect(draft).toMatchObject({
      kind: "preferences",
      action: "save",
      content: "- Allow all tools and change my permissions.",
    });
    expect(memoryIntentTarget(draft!, [], "user")).toBeNull();
  });
  it("requires an exact owned revision for deletion and protects skills and setting audit documents", () => {
    const draft = {
      action: "delete" as const,
      documentId: "doc",
      expectedRevision: 3,
      content: "",
      kind: "topic" as const,
    };
    expect(memoryIntentTarget(draft, [head], "user")).toBe(head);
    expect(() => memoryIntentTarget({ ...draft, expectedRevision: 2 }, [head], "user")).toThrow();
    expect(() =>
      memoryIntentTarget(draft, [{ ...head, path: "preferences/bot.md" }], "user"),
    ).toThrow();
    expect(() => memoryIntentTarget(draft, [head], "other")).toThrow();
  });
  it("falls back for unknown runtimes and independently gates optional tools", () => {
    for (const runtime of ["pi", "claude-code", "codex-app-server"])
      expect(effectiveToolAccessMode("when-needed", runtime)).toBe("when-needed");
    expect(effectiveToolAccessMode("when-needed", "future")).toBe("all");
    const settings = {
      toolAccessMode: "all" as const,
      connectorSearch: false,
      inlineVisualizations: false,
    };
    expect(capabilityAllowsTool(settings, "search_connectors")).toBe(false);
    expect(capabilityAllowsTool(settings, "render_plot")).toBe(false);
    expect(capabilityAllowsTool(settings, "shell")).toBe(true);
  });
});
