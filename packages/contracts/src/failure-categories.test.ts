import { describe, expect, it } from "vitest";
import {
  FAILURE_CATEGORIES,
  FailureCategoryIdSchema,
  failureCategoryFromMemberLine,
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
    ["Worker stopped.", "stopped", {}],
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

  it.each([
    "npm test failed.",
    "The build failed.",
    "The owner stopped.",
    "Reviewer failed.",
    "Reviewer stopped.",
  ])("keeps the words of a recorded reason that ends like a handoff line: %j", (text) => {
    expect(failureCategoryFromText(text)).toBeUndefined();
  });

  it.each([
    "Retrying after: Claude Code's usage limit is reached. Try again after it resets.",
    "Provider request failed: Claude Code's usage limit is reached. Try again after it resets.",
    "It broke. Codex reached this run's turn limit. Narrow the task and try again.",
    "First line\nCodex stopped before finishing this run.",
  ])("keeps the words of a reason that only ends with a category sentence: %j", (text) => {
    expect(failureCategoryFromText(text)).toBeUndefined();
  });

  it("maps a sentence only for a runtime the caller knows, when it names them", () => {
    const text = "Codex's usage limit is reached. Try again after it resets.";
    expect(failureCategoryFromText(text, { runtimes: ["Codex", "Hermes"] })).toEqual({
      id: "usage-limit",
      params: { runtime: "Codex" },
    });
    expect(failureCategoryFromText(text, { runtimes: ["Hermes"] })).toBeUndefined();
    expect(
      failureCategoryFromText(`Again ${text}`, { runtimes: ["Codex", "Hermes"] }),
    ).toBeUndefined();
    // A group sentence names a bot, which no list of runtimes can vouch for.
    expect(
      failureCategoryFromText(
        "Bot v1.2 (test) hit the group model's usage limit. Try again after it resets, or change the group model.",
        { runtimes: ["Codex"] },
      ),
    ).toEqual({ id: "usage-limit", params: { bot: "Bot v1.2 (test)" } });
  });

  it("recognises a handoff line only for the member it was written for", () => {
    expect(failureCategoryFromMemberLine("Reviewer failed.", "Reviewer")).toBe("other");
    expect(failureCategoryFromMemberLine(" Reviewer stopped. ", "Reviewer")).toBe("stopped");
    // Written by older versions, whatever the member was called.
    expect(failureCategoryFromMemberLine("Worker stopped.", "Reviewer")).toBe("stopped");
    expect(failureCategoryFromMemberLine("npm test failed.", "Reviewer")).toBeUndefined();
    expect(failureCategoryFromMemberLine("Reviewer failed.", "Writer")).toBeUndefined();
    expect(
      failureCategoryFromMemberLine("Reviewer failed: out of disk.", "Reviewer"),
    ).toBeUndefined();
    expect(failureCategoryFromMemberLine("", "Reviewer")).toBeUndefined();
  });
});
