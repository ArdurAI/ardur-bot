import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FAILURE_CATEGORIES, failureCategory } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { failureCategoryMemberMessages, failureCategoryMessages } from "./failure-category-copy";

vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
}));

describe("failure-category table completeness", () => {
  it("gives every table id a web message identical to the table's sentence", () => {
    for (const entry of FAILURE_CATEGORIES) {
      const descriptor = failureCategoryMessages[entry.id];
      expect(descriptor, entry.id).toBeTruthy();
      expect(descriptor.message, entry.id).toBe(entry.message);
      if (entry.memberMessage)
        expect(failureCategoryMemberMessages[entry.id]?.message, entry.id).toBe(
          entry.memberMessage,
        );
    }
  });

  it("documents every table id in docs/failure-categories.md", () => {
    const doc = readFileSync(
      fileURLToPath(new URL("../../../../docs/failure-categories.md", import.meta.url)),
      "utf8",
    );
    for (const entry of FAILURE_CATEGORIES) expect(doc, entry.id).toContain(`\`${entry.id}\``);
  });

  it("keeps the table's sentence placeholders renderable through the web messages", () => {
    // A web message may only use the placeholders its table entry declares.
    for (const entry of FAILURE_CATEGORIES) {
      const declared = new Set(
        [...entry.message.matchAll(/\{(bot|runtime|member)\}/g)].map((match) => match[1]),
      );
      for (const used of [
        ...failureCategory(entry.id).message.matchAll(/\{(bot|runtime|member)\}/g),
      ])
        expect(declared.has(used[1]), `${entry.id}: ${used[1]}`).toBe(true);
    }
  });
});
