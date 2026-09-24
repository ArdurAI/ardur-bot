import { createHash } from "node:crypto";
import type {
  MemoryStore,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
} from "@ardurbot/adapter-kit";
import type { MemoryOperationContext, MemoryService } from "@ardurbot/memory";
import { recallDocuments } from "@ardurbot/memory";

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
    ...(doc.delivery.status !== "delivered" ? { status: "Saved; indexing pending" } : {}),
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
  return recallDocuments(service, provider, request, context);
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
