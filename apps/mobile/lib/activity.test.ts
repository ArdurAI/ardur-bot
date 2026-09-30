import type { RunActivityRow } from "@ardurbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityRowPreview } from "../lib/activity";
import { activateUiLocale } from "../lib/i18n";

vi.mock("../lib/api", () => ({ rpc: vi.fn() }));

const run: RunActivityRow = {
  runId: "run",
  botId: "worker",
  botName: "Worker",
  groupId: null,
  groupName: null,
  threadId: "thread",
  status: "failed",
  failureCategory: "usage-limit",
  failureRuntime: "Claude Code",
  trigger: "user",
  notificationsEnabled: true,
  promptSnippet: "Draft documentation",
  updatedAt: "2026-09-28T12:00:00.000Z",
};

afterEach(() => {
  activateUiLocale("en");
});

describe("activityRowPreview", () => {
  it("shows the recorded failure reason next to the failed label", () => {
    const preview = activityRowPreview(run);
    expect(preview).toContain("Claude Code's usage limit is reached.");
    expect(preview).toContain("Failed");
  });

  it("keeps the prompt snippet for a failed run without a recorded category", () => {
    const { failureCategory, failureRuntime, ...rest } = run;
    expect(activityRowPreview(rest)).toBe("Draft documentation · Failed");
  });

  it("shows no English in Russian", () => {
    activateUiLocale("ru");
    const preview = activityRowPreview(run);
    expect(preview).not.toContain("usage limit");
    expect(preview).not.toContain("Failed");
    expect(preview).toContain("Claude Code");
  });

  it("fills the bot's name in a refusal sentence", () => {
    const preview = activityRowPreview({
      ...run,
      failureCategory: "destinations-bot",
      failureRuntime: null,
    });
    expect(preview).toContain("Worker's allowed model destinations block this model.");
    expect(preview).not.toContain("{bot}");
  });
});
