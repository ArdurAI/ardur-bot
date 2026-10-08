export const RESTART_ACTION_MESSAGE =
  "This action may already have happened. Check its outcome before trying again.";
export const RESTART_PAUSED_MESSAGE = "Bot work is still paused after the update. Try again.";
export const RESTART_UPDATE_MESSAGE = "Updating — your bots will continue after the update";
export const RESTART_SESSION_MESSAGE = "This run continued in a new session after a restart.";

export function isRestartEvent(event: { type: string }): boolean {
  return event.type === "run.suspended" || event.type === "run.resumed";
}

/** Every surface projects the same saved restart state, including reconnect snapshots. */
export function reduceRestartState<
  T extends {
    cursor?: number;
    run?: { id: string; restarting?: boolean } | null;
    contextRun?: { id: string; restarting?: boolean } | null;
    activeRuns?: Array<{ id: string; restarting?: boolean }>;
  },
>(snapshot: T, event: { type: string; runId?: string | null; seq?: number }): T {
  if (!isRestartEvent(event) || !event.runId || (event.seq ?? 0) <= (snapshot.cursor ?? -1))
    return snapshot;
  const update = <R extends { id: string; restarting?: boolean }>(run: R): R =>
    run.id === event.runId ? { ...run, restarting: event.type === "run.suspended" } : run;
  return {
    ...snapshot,
    cursor: event.seq ?? snapshot.cursor,
    run: snapshot.run ? update(snapshot.run) : snapshot.run,
    contextRun: snapshot.contextRun ? update(snapshot.contextRun) : snapshot.contextRun,
    activeRuns: snapshot.activeRuns?.map(update),
  };
}
