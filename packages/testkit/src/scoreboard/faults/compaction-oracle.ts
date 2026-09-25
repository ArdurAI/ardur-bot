/**
 * compactHistory does not increment historyCompactionGeneration, so generation 0
 * cannot show that a retry wrote the summary again. The oracle is the number of
 * committed summary writes.
 */
export function classifyCompactionRetry(writes: number): { ok: boolean; reason: string | null } {
  if (!Number.isInteger(writes) || writes < 1)
    return { ok: false, reason: "no-compaction-write-observed" };
  if (writes > 1) return { ok: false, reason: "compaction-written-more-than-once" };
  return { ok: true, reason: null };
}
