import type {
  MemoryDocumentHead,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
} from "@ardurbot/adapter-kit";
import { assertMemorySafe } from "./redaction.js";
import type { MemoryOperationContext, MemoryService } from "./service.js";

export function memoryCitation(doc: Pick<MemoryDocumentHead, "id" | "revision">): string {
  return `[ardur-memory:${doc.id}:${doc.revision}]`;
}
export function memoryDestination(doc: MemoryDocumentHead) {
  const scope = doc.scopeKey;
  return {
    scope: scope.kind === "space-shared" ? ("shared" as const) : ("isolated" as const),
    botId:
      scope.kind === "bot"
        ? scope.botId
        : scope.kind === "user"
          ? `user-${scope.userId}`
          : `space-${scope.spaceId}`,
  };
}
/** The job host serializes each document across revisions and configuration generations.
 * Network IO stays outside database transactions so local saves never wait for indexing.
 */
export async function deliverMemory(
  service: MemoryService,
  id: string,
  revision: number,
  context: MemoryOperationContext,
): Promise<void> {
  const selected = await service.open(context, async (s) => {
    const doc = await s.store.read(id, s.access);
    if (!doc || doc.revision !== revision || doc.delivery.status === "delivered") return null;
    if (
      !s.semantic ||
      s.semantic.describe().id !== doc.delivery.provider ||
      s.generation !== doc.delivery.generation
    )
      throw new Error("The memory destination changed.");
    assertMemorySafe(doc, context.knownSecrets);
    return { doc, provider: s.semantic, access: s.access, generation: s.generation };
  });
  if (!selected) return;
  const { doc, provider, access } = selected;
  let succeeded = false;
  try {
    const result = doc.deletedAt
      ? provider.deleteDocument
        ? await provider.deleteDocument({ documentId: doc.id, ...memoryDestination(doc) }, access)
        : { ok: false }
      : await provider.save(
          {
            content: `${memoryCitation(doc)}\n${doc.content}`,
            ...memoryDestination(doc),
            source: { kind: "durable", documentId: doc.id, revision: doc.revision },
          },
          access,
        );
    succeeded = result.ok;
  } catch {
    // Provider exceptions may contain credentials; persist only the bounded status below.
  }
  await service.open({ ...context, memoryGeneration: selected.generation }, async (s) => {
    const current = await s.store.read(id, s.access);
    if (
      !current ||
      current.revision !== revision ||
      current.delivery.provider !== doc.delivery.provider ||
      current.delivery.generation !== selected.generation
    )
      return;
    await s.store.setDelivery(
      id,
      revision,
      { ...doc.delivery, status: succeeded ? "delivered" : "failed" },
      s.access,
    );
  });
  // Throw after the status transaction commits so Graphile retries without losing the failure.
  if (!succeeded) throw new Error("Saved locally. Indexing failed.");
}
export async function recallDocuments(
  service: MemoryService,
  provider: SemanticMemoryProvider,
  request: SemanticMemoryRecallRequest,
  context: MemoryOperationContext,
): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
  assertMemorySafe(request.query, context.knownSecrets);
  context = { ...context, memoryRecall: true };
  const selected = await service.open(context, async (s) => {
    if (
      !s.access.botIds.includes(request.botId) ||
      (s.access.botId && s.access.botId !== request.botId)
    )
      return null;
    if (!s.semantic || s.semantic.describe().id !== provider.describe().id) return null;
    const bundle = await s.store.exportBundle(s.access);
    return {
      access: s.access,
      generation: s.generation,
      documentIds: bundle.documents
        .filter((doc) => !doc.revisions.at(-1)!.deletedAt)
        .map((doc) => doc.id),
    };
  });
  if (!selected) return { ok: false, error: "This memory is not available to you." };
  if (!selected.documentIds.length) return { ok: true, value: [] };
  let recalled: SemanticMemoryResponse<SemanticMemoryResult[]>;
  try {
    recalled = await provider.recall(
      { ...request, documentIds: selected.documentIds },
      selected.access,
    );
  } catch {
    return { ok: false, error: "Memory recall failed. Retry." };
  }
  if (!recalled.ok) return { ok: false, error: "Memory recall failed. Retry." };
  const results = recalled.value;
  // Recheck current revisions and permissions after the network call, including concurrent deletion.
  return service.open({ ...context, memoryGeneration: selected.generation }, async (s) => {
    const seen = new Set<string>();
    const value: SemanticMemoryResult[] = [];
    for (const result of results) {
      const citation =
        /\[ardur-memory:([a-zA-Z0-9_-]+):(\d+)\]/u.exec(result.memory) ??
        /\[ardur-memory:([a-zA-Z0-9_-]+):(\d+)\]/u.exec(result.provenance ?? "");
      if (!citation) continue;
      const doc = await s.store.read(citation[1]!, s.access);
      if (!doc || doc.deletedAt || doc.revision !== Number(citation[2]) || seen.has(doc.id))
        continue;
      assertMemorySafe(doc, context.knownSecrets);
      seen.add(doc.id);
      value.push({
        id: doc.id,
        memory: doc.content,
        score: result.score,
        provenance: memoryCitation(doc),
        updatedAt: doc.updatedAt,
      });
    }
    return { ok: true, value };
  });
}
