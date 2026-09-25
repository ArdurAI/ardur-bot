import type { ContextAggregate, ContextSnapshot } from "@ardurbot/contracts";
import { ContextSnapshotSchema } from "@ardurbot/contracts";
import type { RecordedContextUsage } from "../run-usage.js";

/** Apply the ledger's accepted delta, never the raw runtime observation. */
export function recordContextUsage(
  snapshot: ContextSnapshot,
  usage: RecordedContextUsage | null,
): void {
  if (!usage) return;
  const cacheComplete = snapshot.inputTokens === null || snapshot.cachedTokens !== null;
  snapshot.inputTokens = (snapshot.inputTokens ?? 0) + usage.inputTokens;
  snapshot.cachedTokens =
    cacheComplete && usage.cachedTokens !== null
      ? (snapshot.cachedTokens ?? 0) + usage.cachedTokens
      : null;
}

/** Keep measured totals across approval and takeover continuations of the same run. */
export function resumeContextSnapshot(
  current: ContextSnapshot,
  previous: unknown,
): ContextSnapshot {
  const parsed = ContextSnapshotSchema.safeParse(previous);
  if (!parsed.success) return current;
  const prior = parsed.data;
  return {
    ...current,
    recallRan: current.recallRan || prior.recallRan,
    recallCalls: current.recallCalls + prior.recallCalls,
    timeToFirstTokenMs: prior.timeToFirstTokenMs,
    queueWaitMs: prior.queueWaitMs ?? current.queueWaitMs,
    cachedTokens: prior.cachedTokens,
    inputTokens: prior.inputTokens,
  };
}

export function percentile(values: number[], proportion: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)]! : null;
}
export function aggregateContext(
  rows: Array<{ botId: string; groupId: string | null; createdAt: Date; contextSnapshot: unknown }>,
  since: Date,
): ContextAggregate[] {
  const groups = new Map<
    string,
    { botId: string; groupId: string | null; snapshots: ContextSnapshot[] }
  >();
  for (const row of rows) {
    if (row.createdAt < since) continue;
    const parsed = ContextSnapshotSchema.safeParse(row.contextSnapshot);
    if (!parsed.success) continue;
    for (const groupId of row.groupId ? [null, row.groupId] : [null]) {
      const key = JSON.stringify([row.botId, groupId]);
      const group = groups.get(key) ?? { botId: row.botId, groupId, snapshots: [] };
      group.snapshots.push(parsed.data);
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(({ botId, groupId, snapshots }) => {
    const firstTokens = snapshots.flatMap((s) =>
      s.timeToFirstTokenMs === null ? [] : [s.timeToFirstTokenMs],
    );
    const queue = snapshots.flatMap((s) => (s.queueWaitMs === null ? [] : [s.queueWaitMs]));
    const cache = snapshots.filter(
      (s) =>
        s.cachedTokens !== null &&
        s.inputTokens !== null &&
        s.inputTokens > 0 &&
        s.cachedTokens <= s.inputTokens,
    );
    return {
      botId,
      groupId,
      runs: snapshots.length,
      measuredFirstTokenRuns: firstTokens.length,
      measuredCacheRuns: cache.length,
      timeToFirstTokenP50Ms: percentile(firstTokens, 0.5),
      timeToFirstTokenP95Ms: percentile(firstTokens, 0.95),
      averagePromptCharacters: Math.round(
        snapshots.reduce(
          (total, s) => total + Object.values(s.layers).reduce((sum, size) => sum + size, 0),
          0,
        ) / snapshots.length,
      ),
      cacheHitRatio: cache.length
        ? cache.reduce((sum, s) => sum + s.cachedTokens!, 0) /
          cache.reduce((sum, s) => sum + s.inputTokens!, 0)
        : null,
      queueWaitP50Ms: percentile(queue, 0.5),
      queueWaitP95Ms: percentile(queue, 0.95),
      recallCalls: snapshots.reduce((sum, s) => sum + s.recallCalls, 0),
    };
  });
}
