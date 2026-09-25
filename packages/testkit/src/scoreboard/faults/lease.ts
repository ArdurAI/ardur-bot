export interface LeaseRow {
  id: string;
  fence: number;
  computerId: string;
  botId: string;
}

// continueRun claims every non-terminal run. queued/leased/running must show a new
// fence when a computer lease already exists. waiting_input and waiting_takeover may
// be retried, which increments that row, or left waiting, which keeps it.
const MUST_RECLAIM = new Set(["queued", "leased", "running"]);
const MAY_RECLAIM = new Set(["waiting_input", "waiting_takeover"]);

export function runWillContinue(statuses: readonly string[]): boolean {
  return statuses.some((status) => MUST_RECLAIM.has(status) || MAY_RECLAIM.has(status));
}

/** Approval and takeover waits are not terminal, and recovery may not reacquire yet. */
export function leaseMayHoldFence(statuses: readonly string[]): boolean {
  return (
    !statuses.some((status) => MUST_RECLAIM.has(status)) &&
    statuses.some((status) => MAY_RECLAIM.has(status))
  );
}

/** Same lease row must be reclaimed. A fresh fence-1 insert is not reclaim. */
export function classifyComputerLeaseReclaim(input: {
  before: readonly LeaseRow[];
  after: readonly LeaseRow[];
  continuing: boolean;
  /** Same row may keep its fence or advance. A replacement is still a failure. */
  reclaimOrHold?: boolean;
}): { ok: boolean; reclaimed: boolean; reason: string } {
  if (input.before.length === 0) return { ok: true, reclaimed: false, reason: "no-lease-at-death" };
  let advanced = true;
  for (const prior of input.before) {
    const same = input.after.find((row) => row.id === prior.id);
    const siblings = input.after.filter(
      (row) => row.computerId === prior.computerId && row.botId === prior.botId,
    );
    if (!same || siblings.length !== 1)
      return { ok: false, reclaimed: false, reason: "lease-row-replaced" };
    if (same.fence < prior.fence)
      return { ok: false, reclaimed: false, reason: "lease-fence-not-advanced" };
    if (same.fence === prior.fence) advanced = false;
    if (input.reclaimOrHold) continue;
    if (input.continuing && same.fence <= prior.fence)
      return { ok: false, reclaimed: false, reason: "lease-fence-not-advanced" };
    if (!input.continuing && same.fence !== prior.fence)
      return { ok: false, reclaimed: false, reason: "terminal-lease-fence-changed" };
  }
  const reclaimed = input.reclaimOrHold ? advanced : input.continuing;
  return {
    ok: true,
    reclaimed,
    reason: reclaimed ? "fence-advanced" : "tombstone-retained",
  };
}

/** Run-lease expiry and the computer-lease verdict are separate observations. */
export function faultRecoveryClocks(input: {
  runLeasesExpired: number;
  computerLeasesAtDeath: number;
  verdict: { ok: boolean; reclaimed: boolean; reason: string };
}) {
  const checks: Record<string, boolean> = {};
  if (input.computerLeasesAtDeath > 0) checks.computerLeaseVerdictAccepted = input.verdict.ok;
  return {
    checks,
    runLeaseClockAdvanced: input.runLeasesExpired > 0,
    computerLeaseReclaimed: input.verdict.reclaimed,
    computerLeaseVerdict: input.verdict.reason,
  };
}
