import type { ReceiptInput } from "./receipt.js";

export function receiptInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    runId: "run-test",
    spaceId: "space-test",
    botId: "bot-test",
    grantId: "grant-test",
    traceId: "trace-test",
    runNonce: "MDEyMzQ1Njc4OWFiY2RlZg",
    step: 0,
    tool: "read_file",
    args: { path: "example.txt" },
    actionClass: "read",
    sideEffectClass: "none",
    target: "example.txt",
    resourceFamily: "filesystem",
    verdict: "compliant",
    reason: "Allowed by rule",
    policyDecisions: [
      { backend: "local", decision: "permit", rule_id: "read", reason: null, eval_ms: 0 },
    ],
    budgetRemaining: {},
    now: new Date("2026-09-29T12:00:00Z"),
    ...overrides,
  };
}
