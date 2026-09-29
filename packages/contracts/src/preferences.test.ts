import { describe, expect, it } from "vitest";
import { DEFAULT_USER_PREFERENCES, PreferencesPatchSchema } from "./preferences.js";

describe("preference patches", () => {
  it("does not inject defaults into unrelated fields or notification switches", () => {
    expect(PreferencesPatchSchema.parse({ notifications: { routines: false } })).toEqual({
      notifications: { routines: false },
    });
    expect(PreferencesPatchSchema.parse({})).toEqual({});
  });
  it.each([
    { theme: "blue" },
    { chatFont: "custom" },
    { motion: false },
    { preferredBrowser: "chrome" },
    { notifications: { routines: "yes" } },
    { sealScenes: "Not a pack!" },
  ])("rejects unsupported values: %j", (patch) => {
    expect(PreferencesPatchSchema.safeParse(patch).success).toBe(false);
  });
  it("stores a seal scene pack by id, or null for the default pack", () => {
    expect(PreferencesPatchSchema.parse({ sealScenes: "simple-ring" })).toEqual({
      sealScenes: "simple-ring",
    });
    expect(PreferencesPatchSchema.parse({ sealScenes: null })).toEqual({ sealScenes: null });
    expect(DEFAULT_USER_PREFERENCES.sealScenes).toBeNull();
  });
  it("preserves existing delivery defaults without granting OS permission", () => {
    expect(DEFAULT_USER_PREFERENCES.notifications).toEqual({
      responseCompletions: true,
      routines: true,
      approvalsNeeded: true,
      dispatchMessages: true,
    });
  });
});
