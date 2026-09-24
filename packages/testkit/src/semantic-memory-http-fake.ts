import { vi } from "vitest";

export type SemanticFixtureKind = "mem0" | "mem0-oss" | "graphiti" | "supermemory" | "serenity";
interface Entry {
  id: string;
  namespace: string;
  runId?: string;
  text: string;
  metadata: Record<string, unknown>;
  episode?: Record<string, unknown>;
  provenance?: string;
}
/** Protocol fixtures have no credentials, listeners, vendor accounts or model calls. */
export function semanticHttpFake(kind: SemanticFixtureKind) {
  const entries: Entry[] = [];
  const pending = new Map<string, Entry>();
  const completed = new Set<string>();
  let serial = 0;
  let fail = 0;
  let tamper: "none" | "foreign" | "future" | "unverified" = "none";
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const mutate = (entry: Entry) => {
    const e = structuredClone(entry);
    if (tamper === "foreign") {
      e.namespace = "forged-namespace";
      e.metadata.namespace = "forged-namespace";
      e.text = "[ardur-memory:foreign-document:1] Foreign";
      e.provenance = "[ardur-memory:foreign-document:1]";
    }
    if (tamper === "future") {
      e.metadata.revision = 999;
      e.text = e.text.replace(/:\d+\]/, ":999]");
      e.provenance = e.provenance?.replace(/:\d+\]/, ":999]");
      if (e.episode) e.episode.source_description = JSON.stringify(e.metadata);
    }
    if (tamper === "unverified") {
      e.metadata = {};
      e.text = "External conclusion";
      e.provenance = "";
    }
    return e;
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method, path, body });
    if (fail) {
      const status = fail;
      fail = 0;
      return Response.json(
        { error: "Injected failure" },
        { status, headers: { "retry-after": "2" } },
      );
    }
    if (kind === "serenity") {
      if (method !== "POST" || body.id === undefined) return new Response(null, { status: 202 });
      const response = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
      if (body.method === "initialize")
        return response({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        });
      const params = body.params as { name: string; arguments: Record<string, string> };
      const args = params.arguments;
      let value: unknown;
      if (params.name === "recall")
        value = {
          facts: entries
            .filter((e) => e.namespace === args.entity)
            .map(mutate)
            .map((e) => ({
              fact_id: e.id,
              fact: e.text,
              provenance: e.provenance,
              entity_slug: e.namespace,
            })),
        };
      else if (params.name === "remember") {
        const id = `fact-${++serial}`;
        entries.push({
          id,
          namespace: args.entity!,
          text: args.fact!,
          provenance: args.provenance,
          metadata: {},
        });
        value = { id, status: "created" };
      } else if (params.name === "forget") {
        const index = entries.findIndex((e) => e.id === args.id);
        if (index >= 0) entries.splice(index, 1);
        value = { id: args.id, expired: true, reason: null };
      } else throw new Error("Unexpected MCP fixture request");
      return response({ content: [{ type: "text", text: JSON.stringify(value) }] });
    }
    if (kind === "supermemory") {
      if (method === "DELETE") {
        const namespace = decodeURIComponent(path.split("/").at(-1)!);
        for (let i = entries.length - 1; i >= 0; i--)
          if (entries[i]!.namespace === namespace) entries.splice(i, 1);
        return Response.json({});
      }
      if (path === "/v4/memories") {
        entries.push({
          id: `fact-${++serial}`,
          namespace: String(body.containerTag),
          text: (body.memories as Array<{ content: string }>)[0]!.content,
          metadata: {},
        });
        return Response.json({});
      }
      if (path === "/v4/search")
        return Response.json({
          results: entries
            .filter((e) => e.namespace === body.containerTag)
            .map(mutate)
            .map((e) => ({ memory: e.text, similarity: 1 })),
        });
      throw new Error("Unexpected Supermemory fixture route");
    }
    if (kind === "graphiti") {
      const namespace = decodeURIComponent(path.split("/").at(-1)!);
      if (path.startsWith("/episodes/"))
        return Response.json(
          entries
            .filter((e) => e.namespace === namespace)
            .map(mutate)
            .map((e) => e.episode),
        );
      if (path === "/messages") {
        const message = (body.messages as Record<string, unknown>[])[0]!;
        const metadata = JSON.parse(String(message.source_description));
        const episode = { ...message, group_id: body.group_id };
        pending.set(String(message.uuid), {
          id: String(message.uuid),
          namespace: String(body.group_id),
          text: String(message.content),
          metadata,
          episode,
        });
        return Response.json({ success: true, message: "Queued" }, { status: 202 });
      }
      const fact = (e: Entry) => ({
        uuid: e.id,
        fact: e.text,
        // The reference REST DTO omits group_id. Only injected boundary failures add it.
        ...(tamper === "foreign" ? { group_id: e.namespace } : {}),
        episodes: tamper === "unverified" ? [] : [e.id],
        invalid_at: null,
        expired_at: null,
      });
      if (path === "/search")
        return Response.json({
          facts: entries
            .filter((e) => (body.group_ids as string[]).includes(e.namespace))
            .map(mutate)
            .map(fact),
        });
      if (path.startsWith("/entity-edge/") && method === "GET") {
        const entry = entries.find((e) => e.id === namespace);
        return Response.json(entry ? fact(entry) : {});
      }
      if (method === "DELETE") {
        for (let i = entries.length - 1; i >= 0; i--)
          if (
            path.startsWith("/group/")
              ? entries[i]!.namespace === namespace
              : entries[i]!.id === namespace
          )
            entries.splice(i, 1);
        return Response.json({ success: true });
      }
      throw new Error("Unexpected Graphiti fixture route");
    }
    const namespace = String(
      (body.filters as { user_id?: string } | undefined)?.user_id ??
        url.searchParams.get("user_id"),
    );
    const mem = (e: Entry) => ({
      id: e.id,
      memory: e.text,
      user_id: e.namespace,
      ...(e.runId ? { run_id: e.runId } : {}),
      metadata: e.metadata,
      score: 1,
    });
    if (path.startsWith("/v1/event/"))
      return Response.json({
        status: completed.has(path.split("/")[3]!) ? "SUCCEEDED" : "PENDING",
      });
    if (method === "DELETE") {
      const id = path.split("/").filter(Boolean).at(-1);
      const index = entries.findIndex((e) => e.id === id);
      if (index >= 0) entries.splice(index, 1);
      return Response.json({ message: "Deleted" });
    }
    if (path === "/v3/memories/add/" || (path === "/memories" && method === "POST")) {
      const id = `memory-${++serial}`;
      const entry = {
        id,
        namespace: String(body.user_id),
        runId: typeof body.run_id === "string" ? body.run_id : undefined,
        text: (body.messages as Array<{ content: string }>)[0]!.content,
        metadata: body.metadata as Record<string, unknown>,
      };
      if (kind === "mem0") {
        pending.set(id, entry);
        return Response.json({ event_id: id, status: "PENDING" });
      }
      entries.push(entry);
      return Response.json({ results: [mem(entry)] });
    }
    const found = entries.filter((e) => e.namespace === namespace);
    if (path === "/search" || path === "/v3/memories/search/") {
      const runId = (body.filters as { run_id?: string }).run_id;
      return Response.json({
        results: found
          .filter((e) => !runId || e.runId === runId)
          .map(mutate)
          .map(mem),
      });
    }
    if (path === "/memories" || path === "/v3/memories/")
      return Response.json({ results: found.map(mem), next: null, count: found.length });
    throw new Error("Unexpected Mem0 fixture route");
  });
  return {
    fetch,
    calls,
    entries,
    failNext: (status = 503) => {
      fail = status;
    },
    tamper: (value: typeof tamper) => {
      tamper = value;
    },
    complete: () => {
      for (const [id, entry] of pending) {
        entries.push(entry);
        completed.add(id);
      }
      pending.clear();
    },
  };
}
