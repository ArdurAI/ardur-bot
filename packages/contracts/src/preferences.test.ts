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
  ])("rejects unsupported values: %j", (patch) => {
    expect(PreferencesPatchSchema.safeParse(patch).success).toBe(false);
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
