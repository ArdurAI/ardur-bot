import { describe, expect, it } from "vitest";
import { DashboardNowSchema, UsagePeriodSchema, UsageSummarySchema } from "./dashboard.js";

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
  it("parses usage from a server that predates the partially reported marker", () => {
    const period = { records: 1, inputTokens: 20, outputTokens: 5, cost: null };
    const summary = UsageSummarySchema.parse({
      inputTokens: 20,
      outputTokens: 5,
      runs: 1,
      dayStart: "2026-09-24T00:00:00Z",
      weekStart: "2026-09-21T00:00:00Z",
      asOf: "2026-09-24T12:00:00Z",
      providers: [{ provider: "fixture", today: period, week: period, daily: [] }],
    });
    expect(summary.providers[0]?.today).toEqual(period);
    expect(
      UsagePeriodSchema.parse({ ...period, incomplete: true }).incomplete,
      "a current server's marker still parses",
    ).toBe(true);
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
