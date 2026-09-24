import { randomUUID } from "node:crypto";
import { memoryTestAccess } from "@ardurbot/testkit/memory-conformance";
import { semanticHttpFake } from "@ardurbot/testkit/semantic-memory-http-fake";
import { describe, expect, it, vi } from "vitest";
import { GraphitiClient } from "./graphiti-client.js";
import {
  GraphitiMemoryProvider,
  graphitiConnection,
  prepareGraphitiConnection,
} from "./graphiti-memory-provider.js";
import { Mem0Client } from "./mem0-client.js";
import {
  Mem0MemoryProvider,
  mem0Connection,
  prepareMem0Connection,
} from "./mem0-memory-provider.js";
import { classifySemanticSettings, SemanticHttpClient, semanticBaseUrl } from "./semantic-http.js";

const context = memoryTestAccess();
const document = {
  documentId: "document",
  revision: 1,
  contentHash: "hash",
  scopeKey: {
    kind: "bot" as const,
    spaceId: context.spaceId,
    userId: context.userId,
    botId: context.botId!,
  },
};
const save = {
  document,
  content: "A portable fact",
  scope: "isolated" as const,
  botId: context.botId!,
  source: { kind: "durable" as const, documentId: "document", revision: 1 },
};
const recall = {
  documents: [document],
  query: "fact",
  scope: "isolated" as const,
  botId: context.botId!,
  limit: 5,
};
const publicDns = async () => [{ address: "203.0.113.10", family: 4 }];

describe("Mem0 HTTP contracts", () => {
  it.each(["mem0", "mem0-oss"] as const)(
    "scopes %s extraction and search to the current revision",
    async (kind) => {
      const http = semanticHttpFake(kind);
      const provider = new Mem0MemoryProvider(
        mem0Connection(kind, { baseUrl: "http://127.0.0.1:8000" }, { apiKey: randomUUID() }),
        { fetch: http.fetch, resolveHostname: publicDns },
      );
      await provider.save(save, context);
      http.complete();
      const nextDocument = { ...document, revision: 2 };
      await provider.save(
        { ...save, document: nextDocument, source: { ...save.source, revision: 2 } },
        context,
      );
      http.complete();
      const adds = http.calls.filter((c) => c.body.messages);
      expect(adds.map((c) => c.body.run_id)).toEqual(["ardur-revision-1", "ardur-revision-2"]);
      expect(
        await provider.recall({ ...recall, documents: [nextDocument] }, context),
      ).toMatchObject({
        ok: true,
        value: [{ source: { documentId: "document", revision: 2 } }],
      });
      expect(http.calls.at(-1)!.body.filters).toMatchObject({ run_id: "ardur-revision-2" });
    },
  );
  it.each(["mem0", "mem0-oss"] as const)(
    "uses the documented %s routes, auth and versioned filters",
    async (kind) => {
      const http = semanticHttpFake(kind);
      const apiKey = randomUUID();
      const connection = mem0Connection(kind, { baseUrl: "http://127.0.0.1:8000" }, { apiKey });
      const client = new Mem0Client(connection, { fetch: http.fetch, resolveHostname: publicDns });
      await client.add("Fact", "namespace", { namespace: "namespace" }, context.signal);
      http.complete();
      await client.search("Fact", "namespace", 5, context.signal);
      await client.list("namespace", context.signal);
      await client.delete("memory-1", context.signal);
      expect(http.calls.map((c) => c.path)).toEqual(
        kind === "mem0"
          ? ["/v3/memories/add/", "/v3/memories/search/", "/v3/memories/", "/v1/memories/memory-1/"]
          : ["/memories", "/search", "/memories", "/memories/memory-1"],
      );
      expect(http.calls[1]!.body).toEqual({
        query: "Fact",
        filters: { user_id: "namespace" },
        top_k: 5,
      });
      const headers = new Headers(http.fetch.mock.calls[0]![1]!.headers);
      expect(headers.get(kind === "mem0" ? "Authorization" : "X-API-Key")).toBe(
        kind === "mem0" ? `Token ${apiKey}` : apiKey,
      );
      expect(() => mem0Connection(kind, { filterVersion: "obsolete" }, { apiKey })).toThrow(
        "filter version",
      );
    },
  );
  it("does not repeat an asynchronous add after reconstructing the platform provider", async () => {
    const http = semanticHttpFake("mem0");
    const network = { fetch: http.fetch, resolveHostname: publicDns };
    const connection = mem0Connection("mem0", {}, { apiKey: randomUUID() });
    const first = await new Mem0MemoryProvider(connection, network).save(save, context);
    expect(first).toMatchObject({ ok: false, pending: true });
    if (first.ok) throw new Error("Expected pending");
    const next = new Mem0MemoryProvider(connection, network);
    expect(await next.save({ ...save, receipt: first.receipt }, context)).toMatchObject({
      ok: false,
      pending: true,
    });
    http.complete();
    expect(await next.save({ ...save, receipt: first.receipt }, context)).toMatchObject({
      ok: true,
    });
    expect(http.calls.filter((c) => c.path === "/v3/memories/add/")).toHaveLength(1);
  });
  it("deletes only metadata-owned matches and never follows pagination URLs", async () => {
    const http = semanticHttpFake("mem0-oss");
    const provider = new Mem0MemoryProvider(
      mem0Connection("mem0-oss", { baseUrl: "http://127.0.0.1:8000" }, {}),
      { fetch: http.fetch },
    );
    await provider.save(save, context);
    http.entries.push({ ...http.entries[0]!, id: "unowned", metadata: { namespace: "forged" } });
    expect(
      await provider.deleteDocument({ documentId: "document", document }, context),
    ).toMatchObject({ ok: true });
    expect(http.entries.map((e) => e.id)).toEqual(["unowned"]);
    let page = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        results: [],
        next: ++page === 1 ? "https://untrusted.example.test/steal" : null,
      }),
    );
    await new Mem0Client(mem0Connection("mem0", {}, { apiKey: randomUUID() }), {
      fetch,
      resolveHostname: publicDns,
    }).list("namespace", context.signal);
    expect(fetch.mock.calls.every((c) => new URL(String(c[0])).host === "api.mem0.ai")).toBe(true);
    expect(String(fetch.mock.calls[1]![0])).toContain("page=2");
  });
  it("fails closed when the OSS list reaches its unpaginated ceiling", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ results: Array.from({ length: 1000 }, () => ({ id: "fixture" })) }),
    );
    const client = new Mem0Client(
      mem0Connection("mem0-oss", { baseUrl: "http://127.0.0.1:8000" }, {}),
      { fetch },
    );
    await expect(client.list("namespace", context.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
describe("Graphiti HTTP contract", () => {
  it("requires the service to confirm deletion instead of trusting an HTTP 200 alone", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ success: false }));
    const client = new GraphitiClient({ baseUrl: "http://127.0.0.1:8000" }, { fetch });
    await expect(client.deleteGroup("namespace", context.signal)).rejects.toThrow();
    await expect(client.deleteEdge("edge", context.signal)).rejects.toThrow();
  });
  it("uses document episodes and waits for a matching persisted episode before reporting delivery", async () => {
    const http = semanticHttpFake("graphiti");
    const network = { fetch: http.fetch, now: () => 0 };
    const connection = graphitiConnection({ baseUrl: "http://127.0.0.1:8000" }, {});
    const first = await new GraphitiMemoryProvider(connection, network).save(save, context);
    expect(first).toMatchObject({ ok: false, pending: true });
    if (first.ok) throw new Error("Expected pending");
    const add = http.calls.find((c) => c.path === "/messages")!;
    expect((add.body.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "document:1",
      timestamp: "1970-01-01T00:00:00.000Z",
    });
    const provider = new GraphitiMemoryProvider(connection, network);
    expect(await provider.save({ ...save, receipt: first.receipt }, context)).toMatchObject({
      ok: false,
      pending: true,
    });
    http.complete();
    expect(await provider.save({ ...save, receipt: first.receipt }, context)).toMatchObject({
      ok: true,
    });
    expect(http.calls.filter((c) => c.path === "/messages")).toHaveLength(1);
    expect(await provider.recall(recall, context)).toMatchObject({
      ok: true,
      value: [{ source: { documentId: "document", revision: 1 } }],
    });
    expect(http.calls.find((c) => c.path === "/search")!.body).toMatchObject({
      group_ids: [add.body.group_id],
    });
  });
  it("never treats a forged episode or edge namespace as an owned fact", async () => {
    const http = semanticHttpFake("graphiti");
    const provider = new GraphitiMemoryProvider(
      { baseUrl: "http://127.0.0.1:8000" },
      { fetch: http.fetch },
    );
    await provider.save(save, context);
    http.complete();
    http.entries[0]!.episode!.group_id = "forged";
    expect(await provider.recall(recall, context)).toEqual({ ok: true, value: [] });
    expect(await provider.forget({ id: http.entries[0]!.id, document }, context)).toMatchObject({
      ok: false,
    });
    expect(http.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
  it("drops explicit foreign provenance inside an otherwise authorized episode", async () => {
    const http = semanticHttpFake("graphiti");
    const provider = new GraphitiMemoryProvider(
      { baseUrl: "http://127.0.0.1:8000" },
      { fetch: http.fetch },
    );
    await provider.save(save, context);
    http.complete();
    http.entries[0]!.episode!.source_description = JSON.stringify({
      ...http.entries[0]!.metadata,
      namespace: "forged-namespace",
    });
    expect(await provider.recall(recall, context)).toEqual({ ok: true, value: [] });
  });
  it("uses bearer auth only when supplied and probes the scoped episodes route", async () => {
    const token = randomUUID();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([]));
    await new GraphitiClient({ baseUrl: "http://127.0.0.1:8000", token }, { fetch }).probe();
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("Authorization")).toBe(
      `Bearer ${token}`,
    );
    expect(String(fetch.mock.calls[0]![0])).toContain(
      "/episodes/ardur-connection-test?last_n=10000",
    );
  });
});
describe("semantic endpoint safety", () => {
  it.each(["http://public.example.test", "http://10.0.0.2"])(
    "refuses non-loopback Graphiti HTTP: %s",
    (baseUrl) => {
      expect(() => graphitiConnection({ baseUrl }, {})).toThrow("HTTPS");
    },
  );
  it.each([
    "https://user:password@example.test",
    "https://example.test/?token=value",
    "https://example.test/#fragment",
    "http://169.254.169.254",
  ])("rejects ambiguous or blocked URLs", (baseUrl) => {
    expect(() => semanticBaseUrl(baseUrl)).toThrow();
  });
  it("gates private DNS before sending credentials and rechecks addresses on each request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const network = { fetch, resolveHostname: async () => [{ address: "10.0.0.2", family: 4 }] };
    const settings = await classifySemanticSettings(
      { baseUrl: "https://memory.example.test" },
      network,
    );
    expect(settings.endpointTrust).toBe("private");
    await expect(
      prepareMem0Connection("mem0-oss", settings, {}, { allowPrivateEndpoint: false }, network),
    ).rejects.toThrow("deployment-owner");
    await expect(
      prepareGraphitiConnection(settings, {}, { allowPrivateEndpoint: false }, network),
    ).rejects.toThrow("deployment-owner");
    const client = new SemanticHttpClient(
      settings,
      {},
      { fetch, resolveHostname: async () => [{ address: "169.254.169.254", family: 4 }] },
    );
    await expect(client.request("GET", "/memories")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("honors Retry-After and returns bounded errors without response bodies or credentials", async () => {
    const credential = randomUUID();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: credential }, { status: 429, headers: { "retry-after": "9" } }),
    );
    const provider = new Mem0MemoryProvider(
      mem0Connection("mem0-oss", { baseUrl: "http://127.0.0.1:8000" }, { apiKey: credential }),
      { fetch },
    );
    const result = await provider.save(save, context);
    expect(result).toMatchObject({ ok: false, pending: true, retryAfterMs: 9000 });
    expect(JSON.stringify(result)).not.toContain(credential);
    fetch.mockRejectedValueOnce(new Error(credential));
    expect(JSON.stringify(await provider.save(save, context))).not.toContain(credential);
    fetch.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: "https://elsewhere.example.test" } }),
    );
    expect(await provider.save(save, context)).toMatchObject({ ok: false });
    expect(fetch.mock.calls.at(-1)![1]!.redirect).toBe("manual");
  });
  it.each(["mem0-oss", "graphiti"] as const)(
    "labels metadata-free %s facts unverified",
    async (kind) => {
      const http = semanticHttpFake(kind);
      const provider =
        kind === "graphiti"
          ? new GraphitiMemoryProvider({ baseUrl: "http://127.0.0.1:8000" }, { fetch: http.fetch })
          : new Mem0MemoryProvider(mem0Connection(kind, { baseUrl: "http://127.0.0.1:8000" }, {}), {
              fetch: http.fetch,
            });
      await provider.save(save, context);
      http.complete();
      http.tamper("unverified");
      expect(await provider.recall(recall, context)).toMatchObject({
        ok: true,
        value: [{ unverified: true, scopeDocumentId: "document" }],
      });
    },
  );
});
