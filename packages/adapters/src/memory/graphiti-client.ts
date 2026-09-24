import type { SemanticHttpConnection, SemanticHttpDependencies } from "./semantic-http.js";
import { record, rows, SemanticHttpClient, SemanticHttpError } from "./semantic-http.js";

export interface GraphitiConnection extends SemanticHttpConnection {
  token?: string;
}
export class GraphitiClient {
  private readonly http: SemanticHttpClient;
  constructor(connection: GraphitiConnection, network?: SemanticHttpDependencies) {
    this.http = new SemanticHttpClient(
      connection,
      connection.token ? { Authorization: `Bearer ${connection.token}` } : {},
      network,
    );
  }
  async episodes(namespace: string, signal: AbortSignal) {
    return rows(
      await this.http.request(
        "GET",
        `/episodes/${encodeURIComponent(namespace)}?last_n=10000`,
        undefined,
        signal,
      ),
      "episodes",
    );
  }
  async add(namespace: string, message: Record<string, unknown>, signal: AbortSignal) {
    const result = record(
      await this.http.request(
        "POST",
        "/messages",
        { group_id: namespace, messages: [message] },
        signal,
      ),
    );
    if (result.success !== true) throw new SemanticHttpError();
  }
  async search(namespace: string, query: string, limit: number, signal: AbortSignal) {
    return rows(
      await this.http.request(
        "POST",
        "/search",
        { group_ids: [namespace], query, max_facts: limit },
        signal,
      ),
      "facts",
    );
  }
  async edge(id: string, signal: AbortSignal) {
    return record(
      await this.http.request("GET", `/entity-edge/${encodeURIComponent(id)}`, undefined, signal),
    );
  }
  async deleteEdge(id: string, signal: AbortSignal) {
    await this.remove(`/entity-edge/${encodeURIComponent(id)}`, signal);
  }
  async deleteGroup(namespace: string, signal: AbortSignal) {
    await this.remove(`/group/${encodeURIComponent(namespace)}`, signal);
  }
  private async remove(path: string, signal: AbortSignal) {
    const result = record(await this.http.request("DELETE", path, undefined, signal));
    if (result.success !== true) throw new SemanticHttpError();
  }
  async probe() {
    // Exercise the scoped data route as well as front-door authentication.
    await this.episodes("ardur-connection-test", new AbortController().signal);
  }
}
