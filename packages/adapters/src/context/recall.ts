import type { AdapterContext, MemoryStore, SemanticMemoryResult } from "@ardurbot/adapter-kit";
import { redactSecrets } from "@ardurbot/core";
import type { MemoryRecallIndex, RecallIndexDocument } from "@ardurbot/memory/node/recall-index";
import { sharedMemoryRecallIndex } from "@ardurbot/memory/node/recall-index";

/** Candidates are re-verified against the store; extra headroom covers rows dropped as stale. */
const RECALL_CANDIDATE_LIMIT = 20;

function queryWords(query: string): Set<string> {
  return new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
}

/** Local-only fallback uses the same authorized document store and revision citations. */
export async function recallLocalDocuments(
  memory: MemoryStore,
  botId: string,
  query: string,
  context: AdapterContext,
  index: MemoryRecallIndex = sharedMemoryRecallIndex,
): Promise<SemanticMemoryResult[]> {
  const words = queryWords(query);
  if (words.size) {
    const indexed = await recallFromIndex(index, memory, botId, context, words).catch(() => null);
    if (indexed) return indexed;
  }
  return scanLocalDocuments(memory, botId, words, context);
}

async function scanLocalDocuments(
  memory: MemoryStore,
  botId: string,
  words: Set<string>,
  context: AdapterContext,
): Promise<SemanticMemoryResult[]> {
  const pages = await Promise.all([
    memory.read({ scope: "bot", botId }, context),
    memory.read({ scope: "user" }, context),
  ]);
  return pages
    .flatMap((page) => page.documents)
    .filter(
      (doc) => doc.id && !doc.path.startsWith("skills/") && !doc.path.startsWith("preferences/"),
    )
    .map((doc) => ({
      doc,
      score: [...words].filter((word) => `${doc.path}\n${doc.content}`.toLowerCase().includes(word))
        .length,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path))
    .slice(0, 5)
    .map(({ doc, score }) => ({
      id: doc.id,
      memory: doc.content,
      score,
      provenance: `[ardur-memory:${doc.id}:${doc.revision}]`,
      updatedAt: doc.updatedAt,
    }));
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
): Promise<SemanticMemoryResult[] | null> {
  const spaceId = context.spaceId;
  // The same two scope reads as the scan, loaded once per slice and kept current by writes.
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
      return {
        id: doc.id,
        memory: doc.content,
        score: hit.score,
        provenance: `[ardur-memory:${doc.id}:${doc.revision}]`,
        updatedAt: doc.updatedAt,
      };
    }),
  );
  return verified.filter((result) => result !== null).slice(0, 5);
}

const escapedSize = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").length;
/** Fit citations and content before recording exposure, including the assembler's escaped frame. */
export function fitContextRecall(
  results: Array<SemanticMemoryResult & { truncated?: boolean }>,
  budget: number,
  secrets: string[],
) {
  let remaining = budget - "<recalled_memory>\n\n</recalled_memory>".length;
  const selected: Array<SemanticMemoryResult & { truncated: boolean }> = [];
  const parts: string[] = [];
  for (const result of results.slice(0, 5)) {
    const heading = `${parts.length ? "\n\n" : ""}${result.provenance ?? "Unverified memory"}\n`;
    const room = remaining - escapedSize(heading);
    if (room <= 0) break;
    const safe = redactSecrets(result.memory, secrets);
    let memory = "";
    let size = 0;
    for (const character of safe) {
      const next = escapedSize(character);
      if (size + next > room) break;
      memory += character;
      size += next;
    }
    if (!memory) continue;
    parts.push(heading + memory);
    selected.push({
      ...result,
      memory,
      truncated: Boolean(result.truncated || memory !== result.memory),
    });
    remaining -= escapedSize(heading) + size;
  }
  return { text: parts.join(""), results: selected };
}
