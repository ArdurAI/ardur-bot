export interface LeaseRow {
  id: string;
  fence: number;
  computerId: string;
  botId: string;
}

// Recovery calls acquireComputerExecutionLease for these. A pending approval stays
// waiting_input and does not take a new fence, so its expired row is a tombstone.
const REACQUIRED_RUN = new Set(["queued", "leased", "running"]);

export function runWillContinue(statuses: readonly string[]): boolean {
  return statuses.some((status) => REACQUIRED_RUN.has(status));
}

/** Same lease row must be reclaimed. A fresh fence-1 insert is not reclaim. */
export function classifyComputerLeaseReclaim(input: {
  before: readonly LeaseRow[];
  after: readonly LeaseRow[];
  continuing: boolean;
}): { ok: boolean; reclaimed: boolean; reason: string } {
  if (input.before.length === 0) return { ok: true, reclaimed: false, reason: "no-lease-at-death" };
  for (const prior of input.before) {
    const same = input.after.find((row) => row.id === prior.id);
    const siblings = input.after.filter(
      (row) => row.computerId === prior.computerId && row.botId === prior.botId,
    );
    if (!same || siblings.length !== 1)
      return { ok: false, reclaimed: false, reason: "lease-row-replaced" };
    if (input.continuing && same.fence <= prior.fence)
      return { ok: false, reclaimed: false, reason: "lease-fence-not-advanced" };
    if (!input.continuing && same.fence !== prior.fence)
      return { ok: false, reclaimed: false, reason: "terminal-lease-fence-changed" };
  }
  return {
    ok: true,
    reclaimed: input.continuing,
    reason: input.continuing ? "fence-advanced" : "tombstone-retained",
  };
}
