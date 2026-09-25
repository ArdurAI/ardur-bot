import { describe, expect, it } from "vitest";
import { providerStreamPlan } from "./provider.js";

function textOf(parts: readonly { bytes: Buffer }[]) {
  return Buffer.concat(parts.map((part) => part.bytes)).toString("utf8");
}

describe("short final provider frame", () => {
  it("waits until the last content byte, the finish frame and DONE", () => {
    const plan = providerStreamPlan("short-final-delta");
    const delays = plan.filter((part) => part.delayBeforeMs > 0);
    expect(delays).toEqual([expect.objectContaining({ delayBeforeMs: 300 })]);
    const delayAt = plan.findIndex((part) => part.delayBeforeMs > 0);
    expect(delayAt).toBeGreaterThan(0);
    const before = textOf(plan.slice(0, delayAt));
    const after = textOf(plan.slice(delayAt));
    expect(before).toContain('"content":"Fir"');
    expect(before).toContain('"content":"Fin"');
    expect(before).not.toContain("[DONE]");
    expect(before).not.toContain('"content":"al."');
    expect(after).toContain('"content":"al."');
    expect(after).toContain("[DONE]");
    expect(after).toContain('"finish_reason":"stop"');
  });
  it("keeps the long gap on the first slice only", () => {
    const gaps = providerStreamPlan("long-gap").filter((part) => part.delayBeforeMs > 0);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.delayBeforeMs).toBe(300);
  });
});
