/** Production Graphile schedules the first stale-lock sweep within this window. */
export const STALE_LOCK_SWEEP_MS = 60_000;
/** Slack so a sweep that starts at the end of that window can finish. */
export const RECOVERY_SWEEP_SLACK_MS = 15_000;
/** Child wait: one full sweep plus slack. The sweep's start stays random. */
export const RECOVERY_OBSERVATION_MS = STALE_LOCK_SWEEP_MS + RECOVERY_SWEEP_SLACK_MS;
/**
 * Parent SIGKILL margin after the observation window, for the oracle reads and the IPC result.
 * Start this budget when the child sends `observing`, not `prepared`. `prepared` is sent before
 * the API is built and before the wait, so startup plus a late sweep would kill a valid observation.
 */
export const RECOVERY_RESULT_MARGIN_MS = 15_000;
export const RECOVERY_DEADLINE_MS = RECOVERY_OBSERVATION_MS + RECOVERY_RESULT_MARGIN_MS;
/** Composition before `observing`. Same bound as the other source-loading stages. */
export const RECOVERY_STARTUP_MS = 300_000;
export const INTERRUPT_DEADLINE_MS = 60_000;

export function faultPhaseBudgetMs(
  phase: "interrupt" | "recover",
  event: "prepared" | "observing",
): number {
  if (event === "observing") {
    if (phase !== "recover") throw new Error("Recovery observation is not an interrupt deadline");
    return RECOVERY_DEADLINE_MS;
  }
  return phase === "recover" ? RECOVERY_STARTUP_MS : INTERRUPT_DEADLINE_MS;
}
