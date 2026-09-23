import { describe, expect, it } from "vitest";
import {
  isModelUnavailableOnSubscription,
  modelIdsUnavailableOnSubscription,
  recommendedDefaultModelId,
} from "./model-defaults.js";

const preferences = [
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.5",
];

describe("recommendedDefaultModelId", () => {
  it.each(preferences)("prefers %s over lower preferences and catalog order", (id) => {
    const available = preferences.slice(preferences.indexOf(id)).reverse();
    expect(recommendedDefaultModelId("openai-codex", ["gpt-5.3-codex-spark", ...available])).toBe(
      id,
    );
  });

  it("falls back to catalog order when no preference is present", () => {
    expect(recommendedDefaultModelId("openai-codex", ["catalog-first", "catalog-second"])).toBe(
      "catalog-first",
    );
  });

  it("preserves catalog order for other providers", () => {
    expect(recommendedDefaultModelId("openai", ["gpt-5.5", "gpt-6-astra"])).toBe("gpt-5.5");
  });

  it("returns undefined for an empty catalog", () => {
    expect(recommendedDefaultModelId("openai-codex", [])).toBeUndefined();
  });

  it.each(["constructor", "__proto__"])("treats %s as an unknown provider", (provider) => {
    expect(recommendedDefaultModelId(provider, ["catalog-first"])).toBe("catalog-first");
    expect(isModelUnavailableOnSubscription(provider, "catalog-first")).toBe(false);
  });
});

describe("subscription availability", () => {
  it("records the verified Codex exclusion", () => {
    expect(modelIdsUnavailableOnSubscription).toEqual({ "openai-codex": ["gpt-5.3-codex-spark"] });
    expect(isModelUnavailableOnSubscription("openai-codex", "gpt-5.3-codex-spark")).toBe(true);
  });

  it("does not exclude other models or providers", () => {
    expect(isModelUnavailableOnSubscription("openai-codex", "gpt-6-astra")).toBe(false);
    expect(isModelUnavailableOnSubscription("openai", "gpt-5.3-codex-spark")).toBe(false);
  });
});
