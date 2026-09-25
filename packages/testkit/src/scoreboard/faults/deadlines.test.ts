import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { faultPhaseBudgetMs, RECOVERY_DEADLINE_MS, RECOVERY_OBSERVATION_MS } from "./deadlines.js";

describe("fault child deadlines", () => {
  it("starts the recovery budget when observation starts, after startup", () => {
    expect(RECOVERY_OBSERVATION_MS).toBe(75_000);
    expect(RECOVERY_DEADLINE_MS).toBe(RECOVERY_OBSERVATION_MS + 15_000);
    expect(faultPhaseBudgetMs("recover", "prepared")).toBe(300_000);
    expect(faultPhaseBudgetMs("recover", "observing")).toBe(RECOVERY_DEADLINE_MS);
    expect(faultPhaseBudgetMs("interrupt", "prepared")).toBe(60_000);
    expect(() => faultPhaseBudgetMs("interrupt", "observing")).toThrow();
  });
  it("starts that budget from the child observing message", () => {
    const parent = readFileSync(new URL("./process.ts", import.meta.url), "utf8");
    const worker = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
    const auxiliary = readFileSync(new URL("./auxiliary.ts", import.meta.url), "utf8");
    expect(parent).toContain('type: "observing"');
    expect(parent).toContain("faultPhaseBudgetMs");
    expect(worker).toContain('type: "observing"');
    expect(auxiliary).toContain('type: "observing"');
    expect(parent).not.toContain("? 90000 : 60000");
  });
});
