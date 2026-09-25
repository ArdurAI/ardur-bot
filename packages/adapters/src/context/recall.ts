import type { AdapterContext, MemoryStore, SemanticMemoryResult } from "@ardurbot/adapter-kit";
import { redactSecrets } from "@ardurbot/core";

/** Local-only fallback uses the same authorized document store and revision citations. */
export async function recallLocalDocuments(
  memory: MemoryStore,
  botId: string,
  query: string,
  context: AdapterContext,
): Promise<SemanticMemoryResult[]> {
  const pages = await Promise.all([
    memory.read({ scope: "bot", botId }, context),
    memory.read({ scope: "user" }, context),
  ]);
  const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
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
