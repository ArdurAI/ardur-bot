import { expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({ ids: ["gpt-5.3-codex-spark", "gpt-6-sol", "gpt-6-astra"] }));
vi.mock("./pi-models.js", () => ({
  listPiCatalog: () => catalog.ids.map((id) => ({ provider: "openai-codex", id })),
  scriptedCatalogEntry: { provider: "scripted", id: "scripted" },
}));

import { defaultCatalogModelId } from "./model-selection.js";

it("keeps the Codex recommendation across every catalog permutation without mutating it", () => {
  const ids = [...catalog.ids];
  for (const first of ids) {
    const rest = ids.filter((id) => id !== first);
    for (const tail of [rest, [...rest].reverse()]) {
      catalog.ids = [first, ...tail];
      const before = [...catalog.ids];
      expect(defaultCatalogModelId("openai-codex")).toBe("gpt-6-astra");
      expect(catalog.ids).toEqual(before);
    }
  }
  expect(defaultCatalogModelId("missing")).toBeNull();
});
