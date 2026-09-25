import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyComputerLeaseReclaim, runWillContinue } from "./lease.js";

const row = { id: "lease-row", fence: 1, computerId: "computer", botId: "bot" };

describe("computer execution lease reclaim", () => {
  it("requires the same row's fence to increase and ignores a fresh insert", () => {
    expect(
      classifyComputerLeaseReclaim({
        before: [row],
        after: [{ ...row, id: "other-row", fence: 1 }],
        continuing: true,
      }),
    ).toMatchObject({ ok: false, reclaimed: false, reason: "lease-row-replaced" });
    expect(
      classifyComputerLeaseReclaim({
        before: [row],
        after: [{ ...row, fence: 2 }],
        continuing: true,
      }),
    ).toMatchObject({ ok: true, reclaimed: true, reason: "fence-advanced" });
    expect(
      classifyComputerLeaseReclaim({
        before: [],
        after: [{ ...row, fence: 1 }],
        continuing: true,
      }).reclaimed,
    ).toBe(false);
    expect(
      classifyComputerLeaseReclaim({
        before: [row],
        after: [row],
        continuing: runWillContinue(["waiting_input"]),
      }),
    ).toMatchObject({ ok: true, reclaimed: false, reason: "tombstone-retained" });
    expect(runWillContinue(["completed"])).toBe(false);
    expect(runWillContinue(["waiting_input"])).toBe(false);
    expect(runWillContinue(["running"])).toBe(true);
  });
  it("expires the dead process lease instead of deleting the row", () => {
    const source = readFileSync(new URL("./process.ts", import.meta.url), "utf8");
    expect(source).not.toContain("computerExecutionLease.deleteMany");
    expect(source).toContain("expireComputerExecutionLeases");
  });
});
