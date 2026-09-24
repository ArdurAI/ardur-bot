import { createHash } from "node:crypto";
import type {
  MemoryStore,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResult,
} from "@ardurbot/adapter-kit";
import type { MemoryOperationContext, MemoryService } from "@ardurbot/memory";
import { recallDocuments } from "@ardurbot/memory";
import { boundedKnowledgeText } from "../knowledge-delivery.js";
import { TOOL_RESULT_TEXT_LIMIT } from "../pi-runtime-limits.js";

export async function saveRunMemory(
  deps: { memory: MemoryStore; memoryDocuments?: MemoryService },
  input: { content: string; path?: string; shared?: boolean },
  context: MemoryOperationContext,
) {
  const documentPath =
    input.path ??
    `facts/${createHash("sha256").update(input.content).digest("hex").slice(0, 24)}.md`;
  if (!deps.memoryDocuments) throw new Error("Memory document delivery is unavailable.");
  const doc = await deps.memoryDocuments.save(
    {
      scope: input.shared ? "space-shared" : "bot",
      botId: context.botId,
      path: documentPath,
      content: input.content,
    },
    context,
  );
  return {
    ok: true,
    documentId: doc.id,
    revision: doc.revision,
    ...(doc.gitSync && doc.gitSync.status !== "pushed"
      ? {
          status:
            doc.gitSync.status === "failed"
              ? "Saved locally. GitHub sync failed."
              : "Saved locally. Sync pending.",
        }
      : doc.delivery.status !== "delivered"
        ? { status: "Saved; indexing pending" }
        : {}),
  };
}
export async function recallRunMemory(
  service: MemoryService | undefined,
  provider: SemanticMemoryProvider,
  request: SemanticMemoryRecallRequest,
  context: MemoryOperationContext,
) {
  if (!service)
    return { ok: false as const, error: "Memory document verification is unavailable." };
  const response = await recallDocuments(service, provider, request, context);
  if (!response.ok) return response;
  const selected = response.value.slice(0, request.limit);
  const limit = Math.floor((TOOL_RESULT_TEXT_LIMIT - 100) / Math.max(1, selected.length)) - 2;
  return {
    ok: true as const,
    value: selected.map((result) => {
      const memory = boundedKnowledgeText(
        result.memory,
        (text) => ({ ...result, memory: text, truncated: false }),
        limit,
      );
      return { ...result, memory, truncated: memory !== result.memory };
    }),
  };
}
export async function forgetRunMemory(
  service: MemoryService | undefined,
  id: string,
  context: MemoryOperationContext,
) {
  if (!service) throw new Error("Memory document delivery is unavailable.");
  const doc = await service.read(id, context);
  if (!doc) return { ok: false, error: "This memory is not available to you." };
  await service.delete(id, doc.revision, context);
  return { ok: true };
}

export function recalledKnowledgeExposures(
  results: Array<SemanticMemoryResult & { truncated?: boolean }>,
  kind: "injected" | "read",
  escapeMarkup = false,
) {
  return results.flatMap((result) => {
    const citation = /\[ardur-memory:([a-zA-Z0-9_-]+):(\d+)\]/u.exec(result.provenance ?? "");
    if (!citation) return [];
    return [
      {
        documentId: citation[1]!,
        activeRevision: Number(citation[2]),
        content: escapeMarkup
          ? result.memory.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
          : result.memory,
        kind,
        truncated: result.truncated ?? false,
      },
    ];
  });
}
