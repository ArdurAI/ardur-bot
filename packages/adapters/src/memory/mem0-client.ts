import type { SemanticHttpDependencies } from "./semantic-http.js";
import { record, rows, SemanticHttpClient, SemanticHttpError } from "./semantic-http.js";

export type Mem0Transport = "platform-v3" | "oss-filters-v1";
export interface Mem0Connection {
  transport: Mem0Transport;
  baseUrl: string;
  apiKey?: string;
  endpointTrust?: string;
}
/** Platform V3 and the OSS REST server have separate routes, auth and list envelopes. */
export class Mem0Client {
  private readonly http: SemanticHttpClient;
  constructor(
    readonly connection: Mem0Connection,
    network?: SemanticHttpDependencies,
  ) {
    this.http = new SemanticHttpClient(
      connection,
      connection.apiKey
        ? connection.transport === "platform-v3"
          ? { Authorization: `Token ${connection.apiKey}` }
          : { "X-API-Key": connection.apiKey }
        : {},
      network,
    );
  }
  get platform() {
    return this.connection.transport === "platform-v3";
  }
  async add(
    content: string,
    namespace: string,
    metadata: Record<string, unknown>,
    signal: AbortSignal,
    runId?: string,
  ) {
    return record(
      await this.http.request(
        "POST",
        this.platform ? "/v3/memories/add/" : "/memories",
        {
          messages: [{ role: "user", content }],
          user_id: namespace,
          ...(runId ? { run_id: runId } : {}),
          metadata,
        },
        signal,
      ),
    );
  }
  async event(id: string, signal: AbortSignal) {
    return record(
      await this.http.request("GET", `/v1/event/${encodeURIComponent(id)}/`, undefined, signal),
    );
  }
  async search(
    query: string,
    namespace: string,
    limit: number,
    signal: AbortSignal,
    runId?: string,
  ) {
    return rows(
      await this.http.request(
        "POST",
        this.platform ? "/v3/memories/search/" : "/search",
        {
          query,
          filters: { user_id: namespace, ...(runId ? { run_id: runId } : {}) },
          top_k: Math.max(1, Math.min(limit, 1000)),
        },
        signal,
      ),
      "results",
    );
  }
  async list(namespace: string, signal: AbortSignal) {
    const results: Record<string, unknown>[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.http.request(
        this.platform ? "POST" : "GET",
        this.platform
          ? `/v3/memories/?page=${page}&page_size=200`
          : `/memories?user_id=${encodeURIComponent(namespace)}&top_k=1000&show_expired=true`,
        this.platform ? { filters: { user_id: namespace }, show_expired: true } : undefined,
        signal,
      );
      const items = rows(response, "results");
      results.push(...items);
      if (!this.platform) {
        // OSS exposes no documented cursor. Do not claim a complete purge at its list ceiling.
        if (items.length >= 1000) throw new SemanticHttpError();
        return results;
      }
      if (!record(response).next) return results;
      // Never follow a response-provided URL with credentials; construct the next page ourselves.
    }
    throw new SemanticHttpError();
  }
  async delete(id: string, signal: AbortSignal) {
    await this.http.request(
      "DELETE",
      this.platform
        ? `/v1/memories/${encodeURIComponent(id)}/`
        : `/memories/${encodeURIComponent(id)}`,
      undefined,
      signal,
    );
  }
  async probe() {
    await this.list("ardur-connection-test", new AbortController().signal);
  }
}
