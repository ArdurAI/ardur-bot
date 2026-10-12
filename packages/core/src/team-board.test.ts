import type { TeamRow } from "@ardurbot/contracts";
import { failureCategoryMessage } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { teamRowText } from "./team-board.js";

const blocked: TeamRow = {
  botId: "worker",
  botName: "Reviewer",
  threadId: "thread",
  cursor: 1,
  state: "blocked",
  sentence: null,
  requesterName: "Chief",
  reason: "Claude Code's usage limit is reached. Try again after it resets.",
  reasonCategory: "usage-limit",
  reasonRuntime: "Claude Code",
  action: "Open conversation",
  rootTaskId: "root",
  delegationId: "handoff",
  canStop: false,
  canAccept: false,
  chain: [],
  delegations: [],
  executing: null,
  usage: { tokens: 0, partial: false, costs: [] },
};

describe("teamRowText failure categories", () => {
  it("renders a categorized blocked reason from the failure-category table", () => {
    expect(teamRowText(blocked)).toBe(
      `Blocked — ${failureCategoryMessage("usage-limit", { runtime: "Claude Code" })}`,
    );
  });

  it("hands the category sentence and its values to the app's translator", () => {
    const calls: Array<{ text: string; values?: Record<string, string | number> }> = [];
    teamRowText(blocked, (text, values) => {
      calls.push({ text, values });
      return text;
    });
    expect(calls).toContainEqual({
      text: "{runtime}'s usage limit is reached. Try again after it resets.",
      values: { runtime: "Claude Code" },
    });
  });

  it("keeps the recorded text for an uncategorized reason", () => {
    const { reasonCategory, reasonRuntime, ...rest } = blocked;
    expect(teamRowText({ ...rest, reason: "rate limit reached; retry later" })).toBe(
      "Blocked — rate limit reached; retry later",
    );
  });

  it.each([
    ["connect-linear", "Connect Linear or grant a team member permission to read and write."],
    ["connect-github", "Connect GitHub or grant a team member permission to read and write."],
  ] as const)("translates pre-dispatch capability blocker key %s", (blockerKey, sentence) => {
    const { reasonCategory, reasonRuntime, ...rest } = blocked;
    const calls: Array<{ text: string }> = [];
    const text = teamRowText({ ...rest, reason: sentence, blockerKey }, (t) => {
      calls.push({ text: t });
      return `[${t}]`;
    });
    expect(calls).toContainEqual({ text: sentence });
    expect(text).toBe(`[Blocked] — [${sentence}]`);
  });
});

it("names the provider on a blocked rate-limit card", () => {
  const text = teamRowText({
    ...blocked,
    reasonCategory: "provider-rate-limit",
    reasonProvider: "Z.AI Coding CN",
    reasonRuntime: "Hermes",
  });
  expect(text).toContain("Z.AI Coding CN is refusing requests right now");
  expect(text).not.toContain("Hermes");
  expect(text).not.toContain("{provider}");
});
