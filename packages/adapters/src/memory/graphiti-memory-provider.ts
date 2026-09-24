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
import type { GraphitiConnection } from "./graphiti-client.js";
import { GraphitiClient } from "./graphiti-client.js";
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

export function graphitiConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): GraphitiConnection {
  if (settings.serviceVersion && settings.serviceVersion !== "graphiti-rest-v1")
    throw new Error("This Graphiti service version is unsupported. Reconnect in Settings.");
  return {
    baseUrl: semanticBaseUrl(settings.baseUrl ?? "", true),
    endpointTrust: settings.endpointTrust,
    token: credentials.token?.trim() || undefined,
  };
}
export async function prepareGraphitiConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options?: { allowPrivateEndpoint?: boolean },
  network?: SemanticHttpDependencies,
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const parsed = graphitiConnection(settings, credentials);
  const classified = await authorizeSemanticConnection(
    { ...settings, baseUrl: parsed.baseUrl },
    options?.allowPrivateEndpoint,
    network,
  );
  await new GraphitiClient({ ...parsed, ...classified }, network).probe();
  return {
    settings: {
      baseUrl: parsed.baseUrl,
      endpointTrust: classified.endpointTrust,
      serviceVersion: "graphiti-rest-v1",
    },
    credentials: parsed.token ? { token: parsed.token } : {},
  };
}
function episodeMetadata(episode: Record<string, unknown>) {
  try {
    return record(JSON.parse(String(episode.source_description)));
  } catch {
    return {};
  }
}
function episodeUuid(namespace: string, name: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([namespace, name]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export class GraphitiMemoryProvider implements SemanticMemoryProvider {
  private readonly client: GraphitiClient;
  constructor(
    connection: GraphitiConnection,
    private readonly network: SemanticHttpDependencies = {},
  ) {
    this.client = new GraphitiClient(connection, network);
  }
  describe() {
    return {
      id: "graphiti",
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
      const document = request.document;
      if (request.source.kind === "durable" && !document) throw new SemanticHttpError();
      const namespace = document
        ? documentNamespace(document, context)
        : historyNamespace(
            request.botId,
            request.source.kind === "history" ? request.source.generation : 0,
            context,
          );
      const contentHash =
        document?.contentHash ?? createHash("sha256").update(request.content).digest("hex");
      const name = document
        ? `${document.documentId}:${document.revision}`
        : `history:${contentHash}`;
      const uuid = episodeUuid(namespace, name);
      const episodes = await this.client.episodes(namespace, context.signal);
      if (
        episodes.some(
          (e) =>
            e.uuid === uuid &&
            e.group_id === namespace &&
            e.name === name &&
            episodeMetadata(e).contentHash === contentHash,
        )
      )
        return { ok: true, value: undefined };
      if (request.receipt) return indexingPending(request.receipt);
      await this.client.add(
        namespace,
        {
          uuid,
          name,
          content: revisionText(request),
          role_type: "user",
          role: null,
          timestamp: new Date(this.network.now?.() ?? Date.now()).toISOString(),
          source_description: JSON.stringify({
            namespace,
            contentHash,
            ...(document ? { documentId: document.documentId, revision: document.revision } : {}),
          }),
        },
        context.signal,
      );
      return indexingPending(uuid);
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
        const episodes = new Map(
          (await this.client.episodes(namespace, context.signal))
            .filter((e) => e.group_id === namespace)
            .map((e) => [e.uuid, e]),
        );
        for (const fact of await this.client.search(
          namespace,
          request.query,
          request.limit,
          context.signal,
        )) {
          if (
            typeof fact.fact !== "string" ||
            (fact.group_id !== undefined && fact.group_id !== namespace) ||
            fact.expired_at ||
            fact.invalid_at
          )
            continue;
          const sources = Array.isArray(fact.episodes) ? fact.episodes : [];
          // A claimed foreign episode is a failed boundary check, not an unverified citation.
          if (sources.some((id) => !episodes.has(id))) continue;
          const metadata = sources.map((id) => episodeMetadata(episodes.get(id)!));
          if (
            metadata.some(
              (m) =>
                (m.namespace !== undefined && m.namespace !== namespace) ||
                (m.documentId !== undefined && m.documentId !== document.documentId) ||
                (m.revision !== undefined &&
                  (!Number.isSafeInteger(m.revision) || Number(m.revision) < 1)),
            )
          )
            continue;
          const matched = metadata
            .sort((a, b) => Number(b.revision) - Number(a.revision))
            .find(
              (m) =>
                m.namespace === namespace &&
                m.documentId === document.documentId &&
                Number.isSafeInteger(m.revision),
            );
          const source = matched
            ? {
                documentId: document.documentId,
                revision: Number(matched.revision),
                ...(typeof matched.contentHash === "string"
                  ? { contentHash: matched.contentHash }
                  : {}),
              }
            : undefined;
          results.push({
            memory: fact.fact,
            score: 1,
            id: typeof fact.uuid === "string" ? fact.uuid : undefined,
            scopeDocumentId: document.documentId,
            source,
            unverified: !source,
            provenance: source
              ? `[ardur-memory:${source.documentId}:${source.revision}]`
              : "from Graphiti, unverified",
          });
        }
      }
      return { ok: true, value: results.slice(0, request.limit) };
    } catch (error) {
      return semanticFailure(error);
    }
  }
  async deleteDocument(
    request: { documentId: string; document?: SemanticMemoryDocument },
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    try {
      if (!request.document || request.document.documentId !== request.documentId)
        throw new SemanticHttpError();
      // Group deletion removes the document's episodes AND derived edges; episode deletion alone does not.
      await this.client.deleteGroup(documentNamespace(request.document, context), context.signal);
      return { ok: true, value: undefined };
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
        await this.client.deleteGroup(
          historyNamespace(request.botId, generation, context),
          context.signal,
        );
      return { ok: true, value: undefined };
    } catch (error) {
      return semanticFailure(error);
    }
  }
  async forget(request: SemanticMemoryForgetRequest, context: AdapterContext) {
    try {
      if (!request.document) throw new SemanticHttpError();
      const namespace = documentNamespace(request.document, context);
      const episodes = new Set(
        (await this.client.episodes(namespace, context.signal))
          .filter((e) => e.group_id === namespace)
          .map((e) => e.uuid),
      );
      const edge = await this.client.edge(request.id, context.signal);
      if (
        !Array.isArray(edge.episodes) ||
        !edge.episodes.length ||
        edge.episodes.some((id) => !episodes.has(id)) ||
        (edge.group_id !== undefined && edge.group_id !== namespace)
      )
        throw new SemanticHttpError();
      await this.client.deleteEdge(request.id, context.signal);
      return { ok: true as const, value: { id: request.id, expired: true, reason: null } };
    } catch (error) {
      return semanticFailure(error);
    }
  }
}
