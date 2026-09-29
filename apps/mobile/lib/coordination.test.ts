// @vitest-environment jsdom
import type { CoordinationBlock } from "@ardurbot/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("./i18n", () => ({
  t: (text: string, args?: Record<string, string | number>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(args?.[key] ?? "")),
  useI18n: () => ({
    t: (text: string, args?: Record<string, string | number>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => String(args?.[key] ?? "")),
  }),
}));

import {
  coordinationAccessibilityLabel,
  coordinationFailureFixable,
  coordinationFailureLine,
  coordinationMemberOutcome,
  coordinationSummary,
} from "./coordination";

function block(patch: Partial<CoordinationBlock> = {}): CoordinationBlock {
  return {
    kind: "coordination",
    nonce: "group-ask:1:run:call-1",
    round: 1,
    text: "Say hello to your teammates.",
    updates: [],
    members: [
      { botId: "radiant", name: "Radiant", outcome: "answered" },
      { botId: "test", name: "test", outcome: "answered" },
      { botId: "zai", name: "zai-bot", outcome: "answered" },
    ],
    ...patch,
  };
}

describe("mobile coordination line", () => {
  it("summarizes a finished round as one line with counts", () => {
    expect(coordinationSummary(block())).toBe("Asked 3 bots · 3 answered");
    expect(coordinationSummary(block({ members: block().members.slice(0, 1) }))).toBe(
      "Asked 1 bot · 1 answered",
    );
    expect(coordinationAccessibilityLabel(block())).toBe("Asked 3 bots · 3 answered");
  });

  it("keeps a failed member to one plain line and marks fixable causes from the code", () => {
    const failed = {
      botId: "zai",
      name: "zai-bot",
      outcome: "failed" as const,
      reasonCode: "auth" as const,
    };
    expect(coordinationFailureLine(failed)).toBe(
      "zai-bot couldn't answer: its model account needs attention",
    );
    expect(coordinationFailureFixable(failed)).toBe(true);
    expect(coordinationFailureFixable({ ...failed, reasonCode: "rate-limit" as const })).toBe(true);
    expect(
      coordinationFailureFixable({ ...failed, reasonCode: "model-unavailable" as const }),
    ).toBe(true);
    expect(coordinationFailureFixable({ ...failed, reasonCode: "other" as const })).toBe(false);
    expect(coordinationFailureLine({ botId: "x", name: "X", outcome: "failed" })).toBe(
      "X couldn't answer",
    );
  });

  it("reads old rounds with an English reason through the mapped code", () => {
    const legacy = {
      botId: "zai",
      name: "zai-bot",
      outcome: "failed" as const,
      reason: "zai-bot couldn't answer: its model is unavailable",
    };
    expect(coordinationFailureLine(legacy)).toBe(
      "zai-bot couldn't answer: its model is unavailable",
    );
    expect(coordinationFailureFixable(legacy)).toBe(true);
    const unknown = {
      botId: "zai",
      name: "zai-bot",
      outcome: "failed" as const,
      reason: "zai-bot froze mid-reply",
    };
    expect(coordinationFailureLine(unknown)).toBe("zai-bot couldn't answer");
    expect(coordinationFailureFixable(unknown)).toBe(false);
  });

  it("labels each member outcome in plain words", () => {
    expect(coordinationMemberOutcome({ botId: "a", name: "A", outcome: "answered" })).toBe(
      "answered",
    );
    expect(coordinationMemberOutcome({ botId: "a", name: "A", outcome: "failed" })).toBe(
      "couldn't answer",
    );
    expect(coordinationMemberOutcome({ botId: "a", name: "A", outcome: "stopped" })).toBe(
      "stopped before answering",
    );
    expect(coordinationMemberOutcome({ botId: "a", name: "A", outcome: "waiting" })).toBe(
      "is waiting for you",
    );
    expect(coordinationMemberOutcome({ botId: "a", name: "A", outcome: "pending" })).toBe(
      "has not answered yet",
    );
  });
});
