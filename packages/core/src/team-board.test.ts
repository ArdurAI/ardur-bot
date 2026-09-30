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
});
