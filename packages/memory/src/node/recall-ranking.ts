import type { RecallIndexDocument, RecallIndexScope } from "./recall-index.js";

/** Match unicode61's word boundaries and Latin diacritic folding without stemming. */
export function recallTokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[\u00c0-\u024f]/gu, (letter) => letter.normalize("NFD").replace(/\p{M}/gu, ""))
      .match(/[\p{L}\p{N}\p{Co}]+/gu) ?? []
  );
}

export interface RecallRank {
  id: string;
  path: string;
  scope: RecallIndexScope;
  coverage: number;
  score: number;
}

const scopePriority = { bot: 0, user: 1, shared: 2 };

export function recallPartition(scope: RecallIndexScope, owner: string): string {
  return JSON.stringify([scope, scope === "shared" ? "" : owner]);
}

/** Coverage, ownership, BM25, then stable identifiers: both recall paths use this order. */
export function rankRecallCandidates<T extends RecallRank>(candidates: readonly T[]): T[] {
  return candidates
    .filter((candidate) => candidate.coverage > 0)
    .sort(
      (a, b) =>
        b.coverage - a.coverage ||
        scopePriority[a.scope] - scopePriority[b.scope] ||
        b.score - a.score ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/** SQLite FTS5 BM25 (k1=1.2, b=0.75), including the index's 3:1 path weighting. */
export function rankRecallScan(
  documents: readonly RecallIndexDocument[],
  words: readonly string[],
) {
  const partitions = new Map<string, RecallIndexDocument[]>();
  for (const doc of documents) {
    const key = recallPartition(doc.scope, doc.owner);
    const partition = partitions.get(key) ?? [];
    partition.push(doc);
    partitions.set(key, partition);
  }
  return rankRecallCandidates(
    [...partitions.values()].flatMap((partition) => scorePartition(partition, words)),
  );
}

function scorePartition(documents: readonly RecallIndexDocument[], words: readonly string[]) {
  const query = [...new Set(words)];
  const rows = documents.map((doc) => {
    const path = recallTokens(doc.path);
    const content = recallTokens(doc.content);
    const frequencies = query.map(
      (word) =>
        path.filter((token) => token === word).length * 3 +
        content.filter((token) => token === word).length,
    );
    return { doc, length: path.length + content.length, frequencies };
  });
  const count = rows.length;
  const averageLength = rows.reduce((sum, row) => sum + row.length, 0) / count || 1;
  const idf = query.map((_, i) => {
    const matches = rows.filter((row) => row.frequencies[i]! > 0).length;
    return Math.max(1e-6, Math.log((count - matches + 0.5) / (matches + 0.5)));
  });
  return rows.map(({ doc, length, frequencies }) => ({
    ...doc,
    coverage: frequencies.filter((frequency) => frequency > 0).length,
    score: frequencies.reduce(
      (sum, frequency, i) =>
        sum +
        (idf[i]! * frequency * 2.2) / (frequency + 1.2 * (0.25 + (0.75 * length) / averageLength)),
      0,
    ),
  }));
}
