import { ContextSnapshotSchema } from "@ardurbot/contracts";

/** Both clients apply the same measured snapshot; old or invalid events cannot replace it. */
export function reduceRunContext<
  T extends {
    cursor?: number;
    run?: { id: string } | null;
    contextRun?: { id: string } | null;
    activeRuns?: Array<{ id: string }>;
  },
>(snapshot: T, event: { runId?: string; seq?: number; payload?: Record<string, unknown> }): T {
  if (!event.runId || (event.seq ?? -1) <= (snapshot.cursor ?? -1)) return snapshot;
  const result = ContextSnapshotSchema.safeParse(event.payload);
  if (!result.success) return snapshot;
  const update = <R extends { id: string }>(run: R): R =>
    run.id === event.runId
      ? { ...run, contextSnapshot: result.data, routingRule: result.data.routingRule }
      : run;
  const current = [snapshot.run, ...(snapshot.activeRuns ?? []), snapshot.contextRun].find(
    (run) => run?.id === event.runId,
  );
  return {
    ...snapshot,
    cursor: event.seq ?? snapshot.cursor,
    run: snapshot.run ? update(snapshot.run) : snapshot.run,
    contextRun: current ? update(current) : snapshot.contextRun,
    activeRuns: snapshot.activeRuns?.map(update),
  };
}
