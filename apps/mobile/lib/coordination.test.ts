// @vitest-environment jsdom

import type { ChiefDispatch } from "@ardurbot/contracts";
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
  chiefActivityText,
  chiefDispatchSummary,
  chiefReceiptText,
  chiefResultText,
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
  it("acknowledges a correction without claiming the member has stopped", () => {
    expect(chiefReceiptText("exclude-member", "Member")).toBe(
      "Got it — I’ll keep Member off this task.",
    );
    expect(chiefReceiptText("change-task")).toBe(
      "Got it — I’ll check this change before the next action.",
    );
    expect(chiefReceiptText("exclude-member")).toBe(
      "Got it — I’ll check the request and choose the next step.",
    );
  });

  it("distinguishes a stop request, confirmation, uncertainty and replacement", () => {
    const dispatch: ChiefDispatch = {
      requestMessageId: "request",
      revision: 87,
      memberId: "replacement",
      memberName: "Replacement",
      state: "messaged",
      reason: "eligible",
    };
    for (const state of ["requested", "confirmed", "uncertain"] as const) {
      const stopping = { ...dispatch, stop: { revision: 86, memberName: "Member", state } };
      expect(chiefDispatchSummary(stopping)).toBe(
        state === "requested"
          ? "Told Member to stand down"
          : state === "confirmed"
            ? "Member stood down"
            : "The previous action may have finished. I’ll check before retrying.",
      );
      expect(chiefActivityText(stopping)).toBe(
        state === "requested" ? "Stopping Member" : undefined,
      );
      expect(chiefDispatchSummary(stopping)).not.toMatch(/86|87|Replacement/);
    }
    expect(chiefDispatchSummary(dispatch)).toBe("Messaged Replacement");
    expect(chiefActivityText(dispatch)).toBe("Working on the task");
  });

  it("shows the committed checking turn without stale activity", () => {
    const dispatch: ChiefDispatch = {
      requestMessageId: "request",
      revision: 2,
      memberId: "member",
      memberName: "Member",
      state: "messaged",
      reason: "saved",
      stop: { revision: 2, memberName: "Member", state: "checking" },
    };
    expect(chiefDispatchSummary(dispatch)).toBe("Checking the earlier action");
    expect(chiefActivityText(dispatch)).toBeUndefined();
  });

  it("shows genuine activity and removes it for waiting and terminal states", () => {
    const dispatch: ChiefDispatch = {
      requestMessageId: "request",
      revision: 1,
      memberId: "worker",
      memberName: "Member",
      state: "messaged",
      reason: "eligible",
    };
    expect(chiefActivityText(dispatch)).toBe("Working on the task");
    const activity = {
      revision: 1,
      runId: "run",
      delegationId: "assignment",
      attempt: 1,
      sourceSeq: 1,
      key: "connect-notion" as const,
      state: "active" as const,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(chiefActivityText({ ...dispatch, activity })).toBe("Connecting to Notion");
    for (const state of ["completed", "failed", "stopped", "waiting"] as const)
      expect(chiefActivityText({ ...dispatch, activity: { ...activity, state } })).toBeUndefined();
    expect(chiefActivityText({ ...dispatch, state: "approval-held", activity })).toBeUndefined();
  });
  it("keeps the draft result to one sentence without a follow-up or unverified success", () => {
    const result = {
      requestMessageId: "request",
      revision: 1,
      artifactId: "file",
      href: "artifact:file",
      state: "draft" as const,
    };
    expect(chiefResultText(result)).toBe("The draft is ready.");
    expect(chiefResultText({ ...result, href: "https://private.example/file" })).toBeUndefined();
  });
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
