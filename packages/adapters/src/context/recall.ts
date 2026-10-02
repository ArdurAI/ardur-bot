import type { AdapterContext, MemoryStore, SemanticMemoryResult } from "@ardurbot/adapter-kit";
import { redactSecrets } from "@ardurbot/core";
import type { MemoryRecallIndex, RecallIndexDocument } from "@ardurbot/memory/node/recall-index";
import {
  rankRecallScan,
  recallTokens,
  sharedMemoryRecallIndex,
} from "@ardurbot/memory/node/recall-index";
import { recallQueryWords } from "./recall-query.js";

/** Candidates are re-verified against the store; extra headroom covers rows dropped as stale. */
const RECALL_CANDIDATE_LIMIT = 20;

const EXCERPT_CHARACTERS = 1200;
type LocalRecallResult = SemanticMemoryResult & { truncated?: boolean };

/** Find the tightest passage with the most distinct query terms, not the first match. */
function recallExcerpt(content: string, words: Set<string>, limit = EXCERPT_CHARACTERS) {
  if (content.length <= limit) return content;
  const matches: Array<{ word: string; start: number; end: number }> = [];
  for (const match of content.matchAll(/[\p{L}\p{N}\p{Co}]+/gu)) {
    const word = recallTokens(match[0])[0]!;
    if (words.has(word))
      matches.push({ word, start: match.index, end: match.index + match[0].length });
  }
  let left = 0;
  let bestStart = 0;
  let bestSpan = Infinity;
  let bestCoverage = 0;
  const counts = new Map<string, number>();
  for (let right = 0; right < matches.length; right++) {
    const match = matches[right]!;
    counts.set(match.word, (counts.get(match.word) ?? 0) + 1);
    while (
      left < right &&
      (match.end - matches[left]!.start > limit - 300 || counts.get(matches[left]!.word)! > 1)
    ) {
      const word = matches[left++]!.word;
      const count = counts.get(word)! - 1;
      if (count) counts.set(word, count);
      else counts.delete(word);
    }
    const span = match.end - matches[left]!.start;
    if (counts.size > bestCoverage || (counts.size === bestCoverage && span < bestSpan)) {
      bestCoverage = counts.size;
      bestSpan = span;
      bestStart = matches[left]!.start;
    }
  }
  const start = Math.max(0, Math.min(bestStart - 150, content.length - limit));
  return content.slice(start, start + limit);
}

function localResult(
  doc: { id: string; content: string; revision: number; updatedAt?: string },
  score: number,
  words: Set<string>,
): LocalRecallResult {
  const memory = recallExcerpt(doc.content, words);
  return {
    id: doc.id,
    memory,
    score,
    provenance: `[ardur-memory:${doc.id}:${doc.revision}]`,
    updatedAt: doc.updatedAt,
    ...(memory !== doc.content ? { truncated: true } : {}),
  };
}

/** Local-only fallback uses the same authorized document store and revision citations. */
export async function recallLocalDocuments(
  memory: MemoryStore,
  botId: string,
  query: string,
  context: AdapterContext,
  index: MemoryRecallIndex = sharedMemoryRecallIndex,
): Promise<LocalRecallResult[]> {
  const words = new Set(recallQueryWords(query));
  if (!words.size) return [];
  const indexed = await index
    .withRecallLock(context.spaceId, async () => {
      // Check both sides of the snapshot/query: a write racing a build must not stamp an
      // older slice with the newer watermark. Retry boundedly, never serve that snapshot.
      for (let attempt = 0; attempt < 3; attempt++) {
        const revision = (await memory.recallRevision?.(context)) ?? null;
        index.synchronize(context.spaceId, revision);
        const results = await recallFromIndex(index, memory, botId, context, words);
        if (revision === null || revision === (await memory.recallRevision?.(context)))
          return results;
        index.invalidate(context.spaceId);
      }
      return [];
    })
    .catch(() => null);
  if (indexed) return indexed;
  return scanLocalDocuments(memory, botId, words, context);
}

async function scanLocalDocuments(
  memory: MemoryStore,
  botId: string,
  words: Set<string>,
  context: AdapterContext,
): Promise<LocalRecallResult[]> {
  const pages = await Promise.all([
    memory.read({ scope: "bot", botId }, context),
    memory.read({ scope: "user" }, context),
  ]);
  const documents = pages
    .flatMap((page, i) =>
      page.documents.map((doc) => ({
        ...doc,
        scope: doc.scope ?? (i === 0 ? ("bot" as const) : ("user" as const)),
        owner: doc.owner ?? (i === 0 ? botId : context.userId),
      })),
    )
    .filter(
      (doc) => doc.id && !doc.path.startsWith("skills/") && !doc.path.startsWith("preferences/"),
    )
    .map((doc) => ({ ...doc, id: doc.id! }));
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  return rankRecallScan(documents, [...words])
    .slice(0, 5)
    .map((rank) => localResult(byId.get(rank.id)!, rank.score, words));
}

/**
 * Answer from the per-space FTS5 index when available. Returns null to fall back to the scan.
 * Every candidate is re-verified against the store before use, exactly like provider recall:
 * a stale or unauthorized row is dropped and the index self-heals from the fresh read.
 */
async function recallFromIndex(
  index: MemoryRecallIndex,
  memory: MemoryStore,
  botId: string,
  context: AdapterContext,
  words: Set<string>,
): Promise<LocalRecallResult[] | null> {
  const spaceId = context.spaceId;
  // Reuse only after the durable watermark has authorized the current space snapshot.
  const slices = [
    { key: `bot:${botId}`, request: { scope: "bot" as const, botId }, scope: "bot" as const },
    { key: `user:${context.userId}`, request: { scope: "user" as const }, scope: "user" as const },
  ];
  for (const slice of slices) {
    if (index.hasSlice(spaceId, slice.key)) continue;
    // Announce the build before the store read so a write that commits while it is in
    // flight buffers into the index and replays over the snapshot.
    index.beginSlice(spaceId, slice.key);
    const page = await memory.read(slice.request, context).catch((error: unknown) => {
      index.abortSlice(spaceId, slice.key);
      throw error;
    });
    const documents: RecallIndexDocument[] = page.documents.flatMap((doc) => {
      if (!doc.id) return [];
      const shared = doc.scope === "shared";
      return [
        {
          id: doc.id,
          path: doc.path,
          content: doc.content,
          revision: doc.revision,
          scope: shared ? ("shared" as const) : slice.scope,
          owner: shared ? "" : (doc.owner ?? (slice.scope === "bot" ? botId : context.userId)),
        },
      ];
    });
    if (!(await index.indexSlice(spaceId, slice.key, documents))) return null;
  }
  const hits = await index.query(spaceId, {
    words: [...words],
    botId,
    userId: context.userId,
    limit: RECALL_CANDIDATE_LIMIT,
  });
  if (!hits) return null;
  const verified = await Promise.all(
    hits.map(async (hit) => {
      const page = await memory.read(
        hit.scope === "bot"
          ? { scope: "bot" as const, botId: hit.owner, path: hit.path }
          : { scope: "user" as const, path: hit.path },
        context,
      );
      const doc = page.documents.find((candidate) => candidate.id === hit.id);
      if (!doc) {
        index.remove(spaceId, hit.id);
        return null;
      }
      if (doc.revision !== hit.revision) {
        // Drop the stale row from this recall; the next one sees the fresh revision.
        index.upsert(spaceId, {
          id: doc.id,
          path: doc.path,
          content: doc.content,
          revision: doc.revision,
          scope: hit.scope,
          owner: hit.owner,
        });
        return null;
      }
      return { doc: { ...doc, id: hit.id }, score: hit.score };
    }),
  );
  return verified
    .filter((result) => result !== null)
    .slice(0, 5)
    .map(({ doc, score }) => localResult(doc, score, words));
}

const escapedSize = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").length;
const PARTIAL_EXCERPT = " [Partial excerpt; read the full document.]";
/** Fit citations and content before recording exposure, including the assembler's escaped frame. */
export function fitContextRecall(
  results: Array<SemanticMemoryResult & { truncated?: boolean }>,
  budget: number,
  secrets: string[],
) {
  let remaining = budget - "<recalled_memory>\n\n</recalled_memory>".length;
  const selected: Array<SemanticMemoryResult & { truncated: boolean }> = [];
  const parts: string[] = [];
  const entries = results
    .slice(0, 5)
    .map((result) => ({
      result,
      safe: redactSecrets(result.memory, secrets),
    }))
    .filter(({ safe }) => safe.length > 0);
  const minimumSize = (entry: (typeof entries)[number], separator: string) => {
    const prefix = `${separator}${entry.result.provenance ?? "Unverified memory"}`;
    const size = escapedSize(entry.safe);
    const full =
      !entry.result.truncated && size <= EXCERPT_CHARACTERS
        ? escapedSize(`${prefix}\n`) + size
        : Infinity;
    const partial =
      escapedSize(`${prefix}${PARTIAL_EXCERPT}\n`) + escapedSize(entry.safe.match(/^./su)![0]);
    return Math.min(full, partial);
  };
  let mandatory = Math.min(3, entries.length);
  // If the budget cannot hold three complete citations, still deliver the highest-ranked fact.
  while (
    mandatory > 1 &&
    entries
      .slice(0, mandatory)
      .reduce((size, entry, i) => size + minimumSize(entry, i ? "\n\n" : ""), 0) > remaining
  )
    mandatory--;
  for (const [i, { result, safe }] of entries.entries()) {
    // Reserve whole short notes or partial citations and one character for the top three.
    const reserved = entries
      .slice(i + 1, mandatory)
      .reduce((size, entry) => size + minimumSize(entry, "\n\n"), 0);
    const prefix = `${parts.length ? "\n\n" : ""}${result.provenance ?? "Unverified memory"}`;
    const partial = Boolean(
      result.truncated ||
        escapedSize(safe) > EXCERPT_CHARACTERS ||
        escapedSize(safe) > remaining - reserved - escapedSize(`${prefix}\n`),
    );
    const heading = `${prefix}${partial ? PARTIAL_EXCERPT : ""}\n`;
    const room = Math.min(EXCERPT_CHARACTERS, remaining - reserved - escapedSize(heading));
    if (room <= 0) break;
    let memory = "";
    let size = 0;
    for (const character of safe) {
      const next = escapedSize(character);
      if (size + next > room || memory.length + character.length > EXCERPT_CHARACTERS) break;
      memory += character;
      size += next;
    }
    if (!memory) continue;
    parts.push(heading + memory);
    selected.push({
      ...result,
      memory,
      truncated: Boolean(partial || memory !== result.memory),
    });
    remaining -= escapedSize(heading) + size;
  }
  return { text: parts.join(""), results: selected };
}
