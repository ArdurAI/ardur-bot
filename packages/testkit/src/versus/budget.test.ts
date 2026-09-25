import { describe, expect, it } from "vitest";
import { BudgetLedger, budgetTemplate, parseBudget } from "./budget.js";
import { selfTestBudget } from "./self-test.js";

describe("versus admission budget", () => {
  it("freezes the admitted envelope against later caller mutation", () => {
    const input = selfTestBudget();
    const ledger = new BudgetLedger(input);
    input.global.requests = 999;
    expect(ledger.budget.global.requests).not.toBe(999);
    expect(() => {
      ledger.budget.global.requests = 999;
    }).toThrow();
  });
  it("requires owner model identity and never turns a template into authorization", () => {
    expect(() => parseBudget(budgetTemplate())).toThrow("SHA-256");
    expect(() => parseBudget({})).toThrow();
  });
  it.each([null, undefined, -1, 0, Infinity, NaN, Number.MAX_SAFE_INTEGER, 1.2])(
    "rejects invalid finite global and trial limits: %s",
    (value) => {
      for (const scope of ["global", "perTrial"] as const)
        for (const key of Object.keys(selfTestBudget()[scope])) {
          const budget = selfTestBudget();
          (budget[scope] as unknown as Record<string, unknown>)[key] = value;
          expect(() => parseBudget(budget)).toThrow();
        }
    },
  );
  it("rejects absent paid pricing, path-bearing endpoints, credentials and unknown fields", () => {
    const budget = selfTestBudget();
    budget.endpoint = {
      origin: "https://provider.example.test",
      paid: true,
      protocol: "ollama-openai",
    };
    budget.currency.cap = 1;
    expect(() => parseBudget(budget)).toThrow();
    for (const origin of [
      "http://127.0.0.1:123/v1",
      "http://local.example.test:123",
      "http://user:pass@127.0.0.1:123",
      "file:///tmp/model",
    ])
      expect(() =>
        parseBudget({ ...selfTestBudget(), endpoint: { ...selfTestBudget().endpoint, origin } }),
      ).toThrow();
    expect(() => parseBudget({ ...selfTestBudget(), unlimited: true })).toThrow();
  });
  it("rejects model drift, inconsistent limits, and concurrency in a serial lane", () => {
    for (const change of [
      { model: { ...selfTestBudget().model, digest: "0".repeat(64) } },
      { model: { ...selfTestBudget().model, id: "--route" } },
      { concurrency: 2 },
      { global: { ...selfTestBudget().global, requests: 1 } },
      { maxOutputTokens: 20000 },
    ])
      expect(() => parseBudget({ ...selfTestBudget(), ...change })).toThrow();
  });
  it("reserves atomically, retains cancellation exposure and counts denied retries only when admitted", async () => {
    const ledger = new BudgetLedger(selfTestBudget());
    ledger.open("a");
    ledger.open("b");
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => ledger.reserve("a", "main")),
      Promise.resolve().then(() => ledger.reserve("b", "retry")),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const reservation = ledger.reservations[0]!;
    ledger.settle(reservation, null);
    expect(ledger.snapshot().global.requests).toBe(1);
    expect(ledger.snapshot().global.logicalInput).toBe(16384);
    expect(ledger.snapshot().reservations[0]?.uncertain).toBe(true);
    expect(() => ledger.settle(reservation, null)).toThrow();
  });
  it("settles authoritative usage conservatively and poisons an overrun", () => {
    const ledger = new BudgetLedger(selfTestBudget());
    ledger.open("a");
    ledger.settle(ledger.reserve("a", "helper"), { logicalInput: 100, output: 20 });
    expect(ledger.snapshot().global.totalTokens).toBe(120);
    expect(() =>
      ledger.settle(ledger.reserve("a", "summary"), { logicalInput: 100000, output: 20 }),
    ).toThrow("exceeded");
    expect(() => ledger.reserve("a", "main")).toThrow("closed");
  });
  it("never expands exhausted global, tool, child, or wall budgets", () => {
    const budget = selfTestBudget();
    budget.global.requests = budget.perTrial.requests = 1;
    let now = 0;
    const ledger = new BudgetLedger(budget, () => now);
    ledger.open("a");
    ledger.open("b");
    ledger.settle(ledger.reserve("a", "delegated"), null);
    expect(() => ledger.reserve("b", "main")).toThrow("budget-exhausted");
    for (let index = 0; index < budget.perTrial.toolCalls; index++) ledger.charge("a", "toolCalls");
    expect(() => ledger.charge("a", "toolCalls")).toThrow();
    for (let index = 0; index < budget.perTrial.descendants; index++)
      ledger.charge("a", "descendants");
    expect(() => ledger.charge("a", "descendants")).toThrow();
    now = budget.perTrial.wallMs;
    expect(() => ledger.remainingMs("a")).toThrow("wall");
  });
});
