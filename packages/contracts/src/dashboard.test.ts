import { describe, expect, it } from "vitest";
import { DashboardNowSchema, UsagePeriodSchema } from "./dashboard.js";

describe("Dashboard read contracts", () => {
  it("keeps usage records distinct from request counts", () => {
    expect(
      UsagePeriodSchema.safeParse({ requests: 1, inputTokens: 20, outputTokens: 5, cost: null })
        .success,
    ).toBe(false);
    expect(
      UsagePeriodSchema.parse({ records: 1, inputTokens: 20, outputTokens: 5, cost: null }),
    ).toEqual({ records: 1, inputTokens: 20, outputTokens: 5, cost: null });
  });
  it("accepts complete pending cards and rejects answered or non-approval blocks", () => {
    const block = {
      kind: "ask",
      status: "pending",
      text: "Send?",
      approvalEffectId: "effect",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    };
    const summary = (block: unknown) => ({
      rows: [],
      runs: [],
      approvals: [{ runId: "run", messageId: "message", block }],
    });
    expect(DashboardNowSchema.safeParse(summary(block)).success).toBe(true);
    for (const invalid of [
      { ...block, status: "answered" },
      { kind: "ask", text: "Which file?", status: "pending" },
      { kind: "ask", text: "Password", input: "secret", status: "pending" },
      { kind: "text", text: "Progress" },
    ])
      expect(DashboardNowSchema.safeParse(summary(invalid)).success).toBe(false);
  });
});
