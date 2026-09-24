import { createHash } from "node:crypto";
import type {
  DocumentDelivery,
  MemoryDocumentHead,
  SemanticMemoryDocument,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
} from "@ardurbot/adapter-kit";
import { DocumentDeliverySchema } from "@ardurbot/contracts";
import { assertMemorySafe } from "./redaction.js";
import type { MemoryOperationContext, MemoryService } from "./service.js";

export function memoryCitation(doc: Pick<MemoryDocumentHead, "id" | "revision">): string {
  return `[ardur-memory:${doc.id}:${doc.revision}]`;
}
export function semanticDocument(
  doc: Pick<MemoryDocumentHead, "id" | "revision" | "content" | "scopeKey">,
): SemanticMemoryDocument {
  return {
    documentId: doc.id,
    revision: doc.revision,
    contentHash: createHash("sha256").update(doc.content).digest("hex"),
    scopeKey: doc.scopeKey,
  };
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
  now: () => number = Date.now,
): Promise<void> {
  const selected = await service.open(context, async (s) => {
    const doc = await s.store.read(id, s.access);
    if (!doc || doc.revision !== revision || doc.delivery.status === "delivered") return null;
    // Typed setting revisions are visible history, never semantic knowledge or prompt instructions.
    if (doc.path.startsWith("preferences/")) {
      await s.store.setDelivery(id, revision, { ...doc.delivery, status: "delivered" }, s.access);
      return null;
    }
    if (doc.delivery.retryAt && Date.parse(doc.delivery.retryAt) > now())
      throw new Error("Saved locally. Indexing pending.");
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
  let delivery: DocumentDelivery = { ...doc.delivery, status: "failed" };
  try {
    const result: SemanticMemoryResponse = doc.deletedAt
      ? provider.deleteDocument
        ? await provider.deleteDocument(
            { documentId: doc.id, document: semanticDocument(doc), ...memoryDestination(doc) },
            access,
          )
        : { ok: false, error: "Document deletion is unsupported." }
      : await provider.save(
          {
            content: `${memoryCitation(doc)}\n${doc.content}`,
            ...memoryDestination(doc),
            source: { kind: "durable", documentId: doc.id, revision: doc.revision },
            document: semanticDocument(doc),
            receipt: doc.delivery.receipt,
          },
          access,
        );
    delivery = DocumentDeliverySchema.parse({
      generation: doc.delivery.generation,
      provider: doc.delivery.provider,
      status: result.ok ? "delivered" : result.pending ? "pending" : "failed",
      ...(!result.ok && (result.receipt ?? doc.delivery.receipt)
        ? { receipt: result.receipt ?? doc.delivery.receipt }
        : {}),
      ...(!result.ok && result.retryAfterMs
        ? {
            retryAt: new Date(
              now() + Math.max(1000, Math.min(result.retryAfterMs, 86_400_000)),
            ).toISOString(),
          }
        : {}),
    });
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
    await s.store.setDelivery(id, revision, delivery, s.access);
  });
  // Throw after the status transaction commits so Graphile retries without losing the failure.
  if (!succeeded)
    throw new Error(
      delivery.status === "pending"
        ? "Saved locally. Indexing pending."
        : "Saved locally. Indexing failed.",
    );
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
      documents: bundle.documents
        .filter(
          (doc) =>
            !doc.revisions.at(-1)!.deletedAt &&
            !doc.revisions.at(-1)!.path.startsWith("preferences/"),
        )
        .map((doc) => semanticDocument({ ...doc.revisions.at(-1)!, id: doc.id })),
    };
  });
  if (!selected) return { ok: false, error: "This memory is not available to you." };
  if (!selected.documents.length) return { ok: true, value: [] };
  let recalled: SemanticMemoryResponse<SemanticMemoryResult[]>;
  try {
    recalled = await provider.recall(
      {
        ...request,
        documentIds: selected.documents.map((d) => d.documentId),
        documents: selected.documents,
      },
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
      if (result.unverified) {
        const original = selected.documents.find((d) => d.documentId === result.scopeDocumentId);
        const current = original ? await s.store.read(original.documentId, s.access) : null;
        if (!current || current.deletedAt || current.revision !== original?.revision) continue;
        assertMemorySafe(result.memory, context.knownSecrets);
        value.push({
          memory: result.memory,
          score: result.score,
          unverified: true,
          provenance: `from ${provider.describe().id}, unverified`,
        });
        continue;
      }
      const citation =
        /\[ardur-memory:([a-zA-Z0-9_-]+):(\d+)\]/u.exec(result.memory) ??
        /\[ardur-memory:([a-zA-Z0-9_-]+):(\d+)\]/u.exec(result.provenance ?? "");
      const id = result.source?.documentId ?? citation?.[1];
      const revision = result.source?.revision ?? Number(citation?.[2]);
      if (!id || !selected.documents.some((d) => d.documentId === id)) continue;
      const doc = await s.store.read(id, s.access);
      if (
        !doc ||
        doc.deletedAt ||
        doc.path.startsWith("preferences/") ||
        seen.has(doc.id) ||
        doc.revision !== revision ||
        (result.source?.contentHash &&
          result.source.contentHash !== semanticDocument(doc).contentHash)
      )
        continue;
      assertMemorySafe(doc, context.knownSecrets);
      if (result.source) assertMemorySafe(result.memory, context.knownSecrets);
      const key = result.source ? `${doc.id}:${doc.revision}:${result.memory}` : doc.id;
      if (seen.has(key)) continue;
      seen.add(key);
      value.push({
        id: doc.id,
        memory: result.source ? result.memory : doc.content,
        score: result.score,
        provenance: memoryCitation(doc),
        updatedAt: doc.updatedAt,
      });
    }
    return { ok: true, value: value.slice(0, request.limit) };
  });
}
