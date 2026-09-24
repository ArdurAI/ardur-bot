import { createHash } from "node:crypto";
import type {
  AdapterContext,
  SemanticMemoryDocument,
  SemanticMemoryForgetRequest,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@ardurbot/adapter-kit";
import type { Mem0Connection } from "./mem0-client.js";
import { Mem0Client } from "./mem0-client.js";
import type { SemanticHttpDependencies } from "./semantic-http.js";
import {
  authorizeSemanticConnection,
  indexingPending,
  record,
  SemanticHttpError,
  semanticBaseUrl,
  semanticFailure,
} from "./semantic-http.js";
import { documentNamespace, historyNamespace, revisionText } from "./semantic-namespace.js";

// Keep extraction/deduplication from attributing a new revision's facts to an older revision.
const revisionRunId = (revision: number) => `ardur-revision-${revision}`;

export function mem0Connection(
  provider: "mem0" | "mem0-oss",
  settings: Record<string, string>,
  credentials: Record<string, string>,
): Mem0Connection {
  const transport = provider === "mem0" ? "platform-v3" : "oss-filters-v1";
  if (settings.filterVersion && settings.filterVersion !== transport)
    throw new Error("This Mem0 filter version is unsupported. Reconnect in Settings.");
  const apiKey = credentials.apiKey?.trim();
  if (provider === "mem0" && !apiKey) throw new Error("An API key is required.");
  return {
    transport,
    baseUrl: provider === "mem0" ? "https://api.mem0.ai" : semanticBaseUrl(settings.baseUrl ?? ""),
    apiKey,
    endpointTrust: provider === "mem0" ? "public" : settings.endpointTrust,
  };
}
export async function prepareMem0Connection(
  provider: "mem0" | "mem0-oss",
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options?: { allowPrivateEndpoint?: boolean },
  network?: SemanticHttpDependencies,
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const parsed = mem0Connection(provider, settings, credentials);
  const classified =
    provider === "mem0"
      ? { baseUrl: parsed.baseUrl, endpointTrust: "public" }
      : await authorizeSemanticConnection(
          { ...settings, baseUrl: parsed.baseUrl },
          options?.allowPrivateEndpoint,
          network,
        );
  await new Mem0Client({ ...parsed, ...classified }, network).probe();
  return {
    settings: {
      baseUrl: parsed.baseUrl,
      endpointTrust: classified.endpointTrust,
      filterVersion: parsed.transport,
    },
    credentials: parsed.apiKey ? { apiKey: parsed.apiKey } : {},
  };
}
export class Mem0MemoryProvider implements SemanticMemoryProvider {
  private readonly client: Mem0Client;
  constructor(connection: Mem0Connection, network?: SemanticHttpDependencies) {
    this.client = new Mem0Client(connection, network);
  }
  describe() {
    return {
      id: this.client.platform ? "mem0" : "mem0-oss",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true } as const,
    };
  }
  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    try {
      if (request.receipt && this.client.platform) {
        const event = await this.client.event(request.receipt, context.signal);
        if (event.status === "SUCCEEDED") return { ok: true, value: undefined };
        if (event.status === "FAILED")
          return { ok: false, error: "Memory indexing failed. Retry." };
        return indexingPending(request.receipt);
      }
      const document = request.document;
      if (request.source.kind === "durable" && !document) throw new SemanticHttpError();
      const namespace = document
        ? documentNamespace(document, context)
        : historyNamespace(
            request.botId,
            request.source.kind === "history" ? request.source.generation : 0,
            context,
          );
      const metadata = {
        namespace,
        kind: request.source.kind,
        ...(document
          ? {
              documentId: document.documentId,
              revision: document.revision,
              contentHash: document.contentHash,
            }
          : {
              generation: request.source.kind === "history" ? request.source.generation : 0,
              contentHash: createHash("sha256").update(request.content).digest("hex"),
            }),
      };
      const existing = (await this.client.list(namespace, context.signal)).filter(
        (item) =>
          record(item.metadata).namespace === namespace &&
          (item.user_id === undefined || item.user_id === namespace),
      );
      if (
        existing.some(
          (item) =>
            record(item.metadata).contentHash === metadata.contentHash &&
            (!document ||
              (record(item.metadata).documentId === document.documentId &&
                record(item.metadata).revision === document.revision)),
        )
      )
        return { ok: true, value: undefined };
      const result = await this.client.add(
        revisionText(request),
        namespace,
        metadata,
        context.signal,
        document ? revisionRunId(document.revision) : undefined,
      );
      if (this.client.platform) {
        if (typeof result.event_id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(result.event_id))
          throw new SemanticHttpError();
        return indexingPending(result.event_id);
      }
      if (!Array.isArray(result.results)) throw new SemanticHttpError();
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ...semanticFailure(error),
        ...(request.receipt ? { receipt: request.receipt } : {}),
      };
    }
  }
  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    try {
      const results: SemanticMemoryResult[] = [];
      for (const document of request.documents ?? []) {
        const namespace = documentNamespace(document, context);
        for (const item of await this.client.search(
          request.query,
          namespace,
          request.limit,
          context.signal,
          revisionRunId(document.revision),
        )) {
          const metadata = record(item.metadata);
          if (
            (item.user_id !== undefined && item.user_id !== namespace) ||
            (item.run_id !== undefined && item.run_id !== revisionRunId(document.revision)) ||
            (metadata.namespace !== undefined && metadata.namespace !== namespace) ||
            (metadata.documentId !== undefined && metadata.documentId !== document.documentId)
          )
            continue;
          if (
            typeof item.memory !== "string" ||
            (metadata.revision !== undefined &&
              (!Number.isSafeInteger(metadata.revision) || Number(metadata.revision) < 1))
          )
            continue;
          const source =
            metadata.namespace === namespace &&
            metadata.documentId === document.documentId &&
            Number.isSafeInteger(metadata.revision) &&
            Number(metadata.revision) > 0
              ? {
                  documentId: document.documentId,
                  revision: Number(metadata.revision),
                  ...(typeof metadata.contentHash === "string"
                    ? { contentHash: metadata.contentHash }
                    : {}),
                }
              : undefined;
          results.push({
            memory: item.memory,
            score: typeof item.score === "number" ? item.score : 1,
            id: typeof item.id === "string" ? item.id : undefined,
            source,
            scopeDocumentId: document.documentId,
            unverified: !source,
            provenance: source
              ? `[ardur-memory:${source.documentId}:${source.revision}]`
              : `from ${this.describe().id}, unverified`,
          });
        }
      }
      return { ok: true, value: results.sort((a, b) => b.score - a.score).slice(0, request.limit) };
    } catch (error) {
      return semanticFailure(error);
    }
  }
  private async remove(
    namespace: string,
    matches: (metadata: Record<string, unknown>, id: string) => boolean,
    context: AdapterContext,
  ) {
    const items = await this.client.list(namespace, context.signal);
    for (const item of items) {
      const metadata = record(item.metadata);
      if (
        typeof item.id === "string" &&
        metadata.namespace === namespace &&
        (item.user_id === undefined || item.user_id === namespace) &&
        matches(metadata, item.id)
      )
        await this.client.delete(item.id, context.signal);
    }
  }
  async deleteDocument(
    request: { documentId: string; document?: SemanticMemoryDocument },
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    try {
      if (!request.document || request.document.documentId !== request.documentId)
        throw new SemanticHttpError();
      await this.remove(
        documentNamespace(request.document, context),
        (m) => m.documentId === request.documentId,
        context,
      );
      return { ok: true, value: undefined };
    } catch (error) {
      return semanticFailure(error);
    }
  }
  async forget(request: SemanticMemoryForgetRequest, context: AdapterContext) {
    try {
      if (!request.document) throw new SemanticHttpError();
      const document = request.document;
      await this.remove(
        documentNamespace(document, context),
        (m, id) => m.documentId === document.documentId && id === request.id,
        context,
      );
      return { ok: true as const, value: { id: request.id, expired: true, reason: null } };
    } catch (error) {
      return semanticFailure(error);
    }
  }
  async purgeHistory(
    request: { botId: string; generations: number[] },
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    try {
      for (const generation of new Set(request.generations))
        await this.remove(
          historyNamespace(request.botId, generation, context),
          (m) => m.kind === "history" && m.generation === generation,
          context,
        );
      return { ok: true, value: undefined };
    } catch (error) {
      return semanticFailure(error);
    }
  }
}
