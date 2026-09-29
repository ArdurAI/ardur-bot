import { describe, expect, it } from "vitest";
import {
  FAILURE_CATEGORIES,
  FailureCategoryIdSchema,
  failureCategoryFromText,
  failureCategoryMessage,
  fillFailureCategoryMessage,
} from "./failure-categories.js";

describe("failure categories table", () => {
  it("gives every category a sentence, an action and a schema-stable id", () => {
    expect(FAILURE_CATEGORIES.length).toBeGreaterThanOrEqual(8);
    const ids = new Set<string>();
    for (const entry of FAILURE_CATEGORIES) {
      expect(FailureCategoryIdSchema.safeParse(entry.id).success, entry.id).toBe(true);
      expect(ids.has(entry.id), `duplicate ${entry.id}`).toBe(false);
      ids.add(entry.id);
      expect(entry.message.trim(), entry.id).toBeTruthy();
      expect(entry.action.kind, entry.id).toBeTruthy();
    }
  });

  it("fills named placeholders and leaves unknown ones readable", () => {
    expect(failureCategoryMessage("usage-limit", { runtime: "Claude Code" })).toBe(
      "Claude Code's usage limit is reached. Try again after it resets.",
    );
    expect(fillFailureCategoryMessage("{member} failed.", { member: "Reviewer" })).toBe(
      "Reviewer failed.",
    );
    expect(fillFailureCategoryMessage("{member} failed.", {})).toBe("{member} failed.");
  });

  it.each([
    [
      "Claude Code's usage limit is reached. Try again after it resets.",
      "usage-limit",
      { runtime: "Claude Code" },
    ],
    [
      "Codex's usage limit is reached. Try again after it resets.",
      "usage-limit",
      { runtime: "Codex" },
    ],
    [
      "Sign in to Claude Code on this computer, then try again.",
      "signed-out",
      { runtime: "Claude Code" },
    ],
    [
      "Codex reached this run's turn limit. Narrow the task and try again.",
      "max-turns",
      { runtime: "Codex" },
    ],
    [
      "Reviewer hit the group model's usage limit. Try again after it resets, or change the group model.",
      "usage-limit",
      { bot: "Reviewer" },
    ],
    [
      "Reviewer's sign-in for the group model expired. Reconnect it or change the group model.",
      "signed-out",
      { bot: "Reviewer" },
    ],
    [
      "Reviewer couldn't use the model set for this group. Reconnect it or change the group model.",
      "connection-missing",
      { bot: "Reviewer" },
    ],
    [
      "Reviewer couldn't use the model set for this group. Change the group model or check this bot's settings.",
      "configuration-invalid",
      { bot: "Reviewer" },
    ],
    ["Worker stopped.", "stopped", { member: "Worker" }],
    ["Reviewer failed.", "other", { member: "Reviewer" }],
    [
      "Claude Code could not finish this run — connect it or change the pin.",
      "other",
      { runtime: "Claude Code" },
    ],
  ] as const)("maps the stored sentence %j back to %s", (text, id, params) => {
    expect(failureCategoryFromText(text)).toEqual({ id, params });
  });

  it("leaves unknown stored text unmapped so callers show their generic line", () => {
    expect(failureCategoryFromText("Timed out.")).toBeUndefined();
    expect(failureCategoryFromText("")).toBeUndefined();
    expect(failureCategoryFromText("   ")).toBeUndefined();
  });
});
