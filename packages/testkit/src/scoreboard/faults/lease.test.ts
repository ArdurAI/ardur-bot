import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyComputerLeaseReclaim,
  faultRecoveryClocks,
  leaseMayHoldFence,
  runWillContinue,
} from "./lease.js";

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
    // Recovery continues waiting_input and acquireComputerExecutionLease increments the row.
    expect(
      classifyComputerLeaseReclaim({
        before: [row],
        after: [{ ...row, fence: 2 }],
        continuing: runWillContinue(["waiting_input"]),
      }),
    ).toMatchObject({ ok: true, reclaimed: true, reason: "fence-advanced" });
    expect(leaseMayHoldFence(["waiting_input"])).toBe(true);
    expect(
      classifyComputerLeaseReclaim({
        before: [row],
        after: [{ ...row, fence: 2 }],
        continuing: false,
        reclaimOrHold: leaseMayHoldFence(["waiting_input"]),
      }),
    ).toMatchObject({ ok: true, reclaimed: true, reason: "fence-advanced" });
    expect(
      classifyComputerLeaseReclaim({
        before: [row],
        after: [row],
        continuing: false,
        reclaimOrHold: leaseMayHoldFence(["waiting_input"]),
      }),
    ).toMatchObject({ ok: true, reclaimed: false, reason: "tombstone-retained" });
    expect(
      classifyComputerLeaseReclaim({
        before: [row],
        after: [row],
        continuing: runWillContinue(["completed"]),
      }),
    ).toMatchObject({ ok: true, reclaimed: false, reason: "tombstone-retained" });
    expect(
      classifyComputerLeaseReclaim({
        before: [row],
        after: [{ ...row, fence: 2 }],
        continuing: runWillContinue(["completed"]),
      }),
    ).toMatchObject({ ok: false, reclaimed: false, reason: "terminal-lease-fence-changed" });
    expect(runWillContinue(["completed"])).toBe(false);
    expect(runWillContinue(["failed"])).toBe(false);
    expect(runWillContinue(["cancelled"])).toBe(false);
    expect(runWillContinue(["waiting_input"])).toBe(true);
    expect(runWillContinue(["waiting_takeover"])).toBe(true);
    expect(runWillContinue(["running"])).toBe(true);
  });
  it("reports crash-02's run-lease clock separately from a completed run's tombstone", () => {
    const crash02 = faultRecoveryClocks({
      runLeasesExpired: 1,
      computerLeasesAtDeath: 0,
      verdict: classifyComputerLeaseReclaim({
        before: [],
        after: [],
        continuing: runWillContinue(["leased"]),
      }),
    });
    expect(crash02.runLeaseClockAdvanced).toBe(true);
    expect(crash02.computerLeaseReclaimed).toBe(false);
    expect(crash02.computerLeaseVerdict).toBe("no-lease-at-death");
    expect(crash02.checks.computerLeaseReclaimed).not.toBe(true);

    const completed = faultRecoveryClocks({
      runLeasesExpired: 0,
      computerLeasesAtDeath: 1,
      verdict: classifyComputerLeaseReclaim({
        before: [row],
        after: [row],
        continuing: runWillContinue(["completed"]),
      }),
    });
    expect(completed.computerLeaseVerdict).toBe("tombstone-retained");
    expect(completed.computerLeaseReclaimed).toBe(false);
    expect(completed.checks.computerLeaseReclaimed).not.toBe(true);
    expect(completed.checks.computerLeaseVerdictAccepted).toBe(true);
    expect(completed.runLeaseClockAdvanced).toBe(false);

    const continued = faultRecoveryClocks({
      runLeasesExpired: 1,
      computerLeasesAtDeath: 1,
      verdict: classifyComputerLeaseReclaim({
        before: [row],
        after: [{ ...row, fence: 2 }],
        continuing: runWillContinue(["waiting_input"]),
      }),
    });
    expect(continued.runLeaseClockAdvanced).toBe(true);
    expect(continued.computerLeaseReclaimed).toBe(true);
    expect(continued.computerLeaseVerdict).toBe("fence-advanced");
    expect(continued.checks.computerLeaseVerdictAccepted).toBe(true);
  });
  it("expires the dead process lease instead of deleting the row", () => {
    const source = readFileSync(new URL("./process.ts", import.meta.url), "utf8");
    expect(source).not.toContain("computerExecutionLease.deleteMany");
    expect(source).toContain("expireComputerExecutionLeases");
  });
});
