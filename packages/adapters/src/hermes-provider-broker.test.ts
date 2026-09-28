import type { AgentUsage } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  type BrokerOptions,
  type BrokerRequest,
  HermesProviderBroker,
  hermesToolName,
} from "./hermes-provider-broker.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fixture(patch: Partial<BrokerOptions> = {}) {
  const records: AgentUsage[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    json({ model: "fixture-model", usage: { prompt_tokens: 0, completion_tokens: 0 } }),
  );
  const scope: BrokerOptions["scope"] = {
    runId: "run",
    botId: "bot",
    userId: "user",
    spaceId: "space",
    operationId: "operation",
    leaseOwner: "worker",
    leaseFence: 2,
    hostGeneration: 3,
    configurationHash: "configuration",
    pin: {
      credentialId: "connection",
      provider: "compatible",
      modelId: "fixture-model",
      effort: "high",
    },
  };
  const options: BrokerOptions = {
    scope,
    connection: {
      credentialId: "connection",
      provider: "compatible",
      modelId: "fixture-model",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "placeholder",
      route: "openai-completions",
      contextWindow: 80,
      maxOutputTokens: 20,
      acceptsImages: true,
      supportsDeveloperRole: false,
      effort: { field: "reasoning_effort", supported: ["off", "high"] },
      reportedModel: "required",
    },
    credentialId: "connection",
    pinnedEffort: "high",
    tools: [{ name: "fixture_echo", description: "Echo", parameters: { type: "object" } }],
    maxRequests: 2,
    maxReservedTokens: 200,
    expiresAt: Date.now() + 60_000,
    active: async () => true,
    record: async (usage) => {
      records.push(usage);
    },
    fetch,
    ...patch,
  };
  const broker = new HermesProviderBroker(options);
  const body = {
    model: "fixture-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: hermesToolName("fixture_echo"),
          description: "untrusted",
          parameters: {},
        },
      },
    ],
    tool_choice: { type: "function", function: { name: hermesToolName("fixture_echo") } },
    stream: false,
  };
  const request = (override: Partial<BrokerRequest> = {}): BrokerRequest => ({
    grant: broker.grant,
    scope,
    path: "/v1/chat/completions",
    body,
    ...override,
  });
  return { broker, options, request, fetch, records, body };
}

describe("worker provider broker", () => {
  it("records model evidence only from a validated response", async () => {
    const observed = vi.fn(async (_model: string | undefined, _effort: string | undefined) => {});
    const matching = fixture({ observed });
    await matching.broker.open(matching.request());
    expect(observed).toHaveBeenCalledWith("fixture-model", "high");

    observed.mockClear();
    const absent = fixture({
      observed,
      connection: { ...matching.options.connection, reportedModel: "if-present" },
      fetch: vi.fn(async () => json({ usage: { prompt_tokens: 1 } })),
    });
    await absent.broker.open(absent.request());
    expect(observed).toHaveBeenCalledWith(undefined, "high");

    observed.mockClear();
    const substituted = fixture({
      observed,
      fetch: vi.fn(async () => json({ model: "different-model" })),
    });
    await expect(substituted.broker.open(substituted.request())).rejects.toThrow("Provider request failed.");
    expect(observed).not.toHaveBeenCalled();

    const failed = fixture({ observed, fetch: vi.fn(async () => { throw new Error("offline"); }) });
    await expect(failed.broker.open(failed.request())).rejects.toThrow();
    expect(observed).not.toHaveBeenCalled();
  });
  it("refuses a provider request that dropped required Ardur context", async () => {
    const f = fixture({ requiredContext: "Required Ardur instruction" });
    await expect(f.broker.open(f.request())).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.records).toHaveLength(0);
    const delivered = {
      ...f.body,
      messages: [{ role: "system", content: "Required Ardur instruction" }, ...f.body.messages],
    };
    expect((await f.broker.open(f.request({ body: delivered }))).ok).toBe(true);
  });
  it("accepts the raw response boundary and rejects the next byte before recording success", async () => {
    const prefix = JSON.stringify({ model: "fixture-model", padding: "" });
    const body = (bytes: number) =>
      json({ model: "fixture-model", padding: "x".repeat(bytes - Buffer.byteLength(prefix)) });
    const f = fixture({ maxRequests: 2, maxReservedTokens: 200 });
    f.fetch.mockResolvedValueOnce(body(4 * 1024 * 1024));
    expect((await f.broker.open(f.request())).ok).toBe(true);
    f.fetch.mockResolvedValueOnce(body(100));
    await expect(f.broker.open(f.request())).rejects.toThrow("Provider request failed");
    expect(f.records.filter((row) => row.request?.collection?.outcome === "success")).toHaveLength(
      1,
    );
  });

  it("applies the response allowance across provider calls in one turn", async () => {
    const f = fixture();
    const body = (padding: number) =>
      json({ model: "fixture-model", padding: "x".repeat(padding) });
    f.fetch.mockResolvedValueOnce(body(2 * 1024 * 1024));
    f.fetch.mockResolvedValueOnce(body(2 * 1024 * 1024));
    expect((await f.broker.open(f.request())).ok).toBe(true);
    await expect(f.broker.open(f.request())).rejects.toThrow("Provider request failed");
    expect(f.records.filter((row) => row.request?.collection?.outcome === "success")).toHaveLength(
      1,
    );
  });
  it("owns a grant before the first asynchronous active check", async () => {
    let release!: (value: boolean) => void;
    const active = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(true);
    const f = fixture({ active });
    const first = f.broker.open(f.request());
    await expect(f.broker.open(f.request())).rejects.toThrow();
    release(true);
    await first;
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.records.filter((row) => row.request?.counter.sequence === 0)).toHaveLength(1);
  });

  it("refuses a grant revoked during its first active check", async () => {
    let release!: (value: boolean) => void;
    const active = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(true);
    const f = fixture({ active });
    const pending = f.broker.open(f.request());
    f.broker.revoke();
    release(true);
    await expect(pending).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("keeps a complete SSE usage event when a later read fails", async () => {
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0)
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"model":"fixture-model","usage":{"prompt_tokens":17,"completion_tokens":4}}\n\n',
            ),
          );
        else controller.error(new Error("reset"));
      },
    });
    const f = fixture({
      fetch: vi.fn(
        async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      ),
    });
    await expect(f.broker.open(f.request({ body: { ...f.body, stream: true } }))).rejects.toThrow();
    expect(f.records.at(-1)?.request).toMatchObject({
      categories: { logicalInput: 17, output: 4 },
      collection: { outcome: "failed" },
    });
  });

  it("fails a streamed error after retaining measured usage without exposing provider text", async () => {
    const providerText = "private provider diagnostic";
    const f = fixture({
      fetch: vi.fn(
        async () =>
          new Response(
            `data: {"model":"fixture-model","choices":[]}\n\ndata: {"usage":{"prompt_tokens":17,"completion_tokens":4}}\n\ndata: {"error":{"message":"${providerText}","code":"internal"}}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    });
    const outcome = await f.broker
      .open(f.request({ body: { ...f.body, stream: true } }))
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Provider request failed.");
    expect(JSON.stringify(outcome)).not.toContain(providerText);
    expect(f.records.at(-1)?.request).toMatchObject({
      categories: { logicalInput: 17, output: 4 },
      collection: { outcome: "failed" },
    });
  });

  it("fails a JSON error envelope without exposing provider text", async () => {
    const providerText = "private provider diagnostic";
    const f = fixture({
      fetch: vi.fn(async () =>
        json({
          model: "fixture-model",
          usage: { prompt_tokens: 9, completion_tokens: 2 },
          error: { message: providerText },
        }),
      ),
    });
    const outcome = await f.broker.open(f.request()).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Provider request failed.");
    expect(JSON.stringify(outcome)).not.toContain(providerText);
    expect(f.records.at(-1)?.request).toMatchObject({
      categories: { logicalInput: 9, output: 2 },
      collection: { outcome: "failed" },
    });
  });

  it("cancels an unsupported response body before finishing", async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const f = fixture({
      fetch: vi.fn(async () => new Response(stream, { headers: { "content-type": "text/plain" } })),
    });
    await expect(f.broker.open(f.request())).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(f.records.at(-1)?.request?.collection?.outcome).toBe("failed");
  });
  it("forwards canonical Ardur tools and exact model/effort, preserving measured zero", async () => {
    const f = fixture();
    const result = await f.broker.open(f.request());
    expect(result.status).toBe(200);
    const sent = JSON.parse(String(f.fetch.mock.calls[0]?.[1]?.body));
    expect(sent.model).toBe("fixture-model");
    expect(sent.reasoning_effort).toBe("high");
    expect(sent.max_tokens).toBe(20);
    expect(sent.tools).toEqual([
      {
        type: "function",
        function: {
          name: hermesToolName("fixture_echo"),
          description: "Echo",
          parameters: { type: "object" },
        },
      },
    ]);
    expect(f.records.map((row) => row.request?.collection?.outcome)).toEqual([
      "started",
      "started",
      "success",
    ]);
    expect(f.records[0]?.request).toMatchObject({
      purpose: "unknown",
      admission: { reservedTokens: 100, maxRequests: 2 },
      categories: { logicalInput: null, output: null },
    });
    expect(f.records[1]?.request?.categories).toMatchObject({
      logicalInput: 0,
      output: 0,
      cacheReadInput: null,
    });
    expect(JSON.stringify(f.records)).not.toContain("placeholder");
    expect(JSON.stringify(f.records)).not.toContain(f.broker.grant.token);
  });

  it("forwards a gpt-4.1 completion limit without changing its parameter or reservation", async () => {
    const base = fixture();
    const provider = vi.fn<typeof globalThis.fetch>(async () =>
      json({ model: "gpt-4.1", usage: { prompt_tokens: 3, completion_tokens: 2 } }),
    );
    const f = fixture({
      scope: {
        ...base.options.scope,
        pin: { ...base.options.scope.pin, modelId: "gpt-4.1" },
      },
      connection: {
        ...base.options.connection,
        modelId: "gpt-4.1",
      },
      fetch: provider,
    });
    const response = await f.broker.open(
      f.request({
        scope: f.options.scope,
        body: { ...f.body, model: "gpt-4.1", max_completion_tokens: 12 },
      }),
    );
    expect(response.ok).toBe(true);
    const sent = JSON.parse(String(provider.mock.calls[0]?.[1]?.body));
    expect(sent.max_completion_tokens).toBe(12);
    expect(sent).not.toHaveProperty("max_tokens");
    expect(f.records[0]?.request?.admission?.reservedTokens).toBe(100);
    expect(f.records.at(-1)?.request?.collection?.outcome).toBe("success");
  });

  it.each([
    ["over cap", { max_completion_tokens: 21 }],
    ["both names", { max_tokens: 12, max_completion_tokens: 12 }],
  ])("rejects %s before provider I/O", async (_reason, fields) => {
    const f = fixture();
    await expect(f.broker.open(f.request({ body: { ...f.body, ...fields } }))).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.records).toHaveLength(0);
  });

  it("pins the connection and tool schema when the grant is created", async () => {
    const f = fixture();
    const savedScope = structuredClone(f.options.scope);
    const tools = f.options.tools as Array<{ name: string; parameters: Record<string, unknown> }>;
    tools[0]!.parameters.type = "array";
    f.options.connection.modelId = "other";
    f.options.connection.baseUrl = "http://169.254.169.254/v1";
    f.options.scope.pin.modelId = "other";
    await f.broker.open(f.request({ scope: savedScope }));
    const sent = JSON.parse(String(f.fetch.mock.calls[0]?.[1]?.body));
    expect(sent.model).toBe("fixture-model");
    expect(sent.tools[0].function.parameters).toEqual({ type: "object" });
  });

  it("maps bounded SSE usage and leaves omitted categories unknown", async () => {
    const f = fixture({
      fetch: vi.fn(
        async () =>
          new Response(
            'data: {"model":"fixture-model","choices":[]}\n\ndata: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    });
    await f.broker.open(f.request({ body: { ...f.body, stream: true } }));
    expect(f.records.at(-1)?.request?.categories).toMatchObject({
      logicalInput: 12,
      output: 3,
      cacheReadInput: null,
      reasoning: null,
    });
    expect(f.records.at(-1)?.request?.collection?.outcome).toBe("success");
  });

  it("retains numeric usage when the provider reports the wrong model", async () => {
    const f = fixture({
      fetch: vi.fn(async () =>
        json({
          model: "other",
          usage: { prompt_tokens: 9, completion_tokens: 2 },
        }),
      ),
    });
    await expect(f.broker.open(f.request())).rejects.toThrow("Provider request failed");
    expect(f.records.at(-1)?.request).toMatchObject({
      categories: { logicalInput: 9, output: 2 },
      collection: { outcome: "failed" },
    });
  });

  it("keeps absent usage unknown on a successful response", async () => {
    const f = fixture({ fetch: vi.fn(async () => json({ model: "fixture-model" })) });
    await f.broker.open(f.request());
    expect(f.records.at(-1)?.request).toMatchObject({
      categories: { logicalInput: null, output: null },
      collection: { outcome: "success", availability: "unavailable" },
    });
  });

  it.each([
    [
      "foreign tool",
      (f: ReturnType<typeof fixture>) => ({
        ...f.body,
        tools: [{ type: "function", function: { name: "terminal" } }],
      }),
    ],
    [
      "native child",
      (f: ReturnType<typeof fixture>) => ({
        ...f.body,
        tools: [{ type: "function", function: { name: "delegate_task" } }],
      }),
    ],
    ["model", (f: ReturnType<typeof fixture>) => ({ ...f.body, model: "other" })],
    ["effort", (f: ReturnType<typeof fixture>) => ({ ...f.body, reasoning_effort: "low" })],
    ["extension", (f: ReturnType<typeof fixture>) => ({ ...f.body, provider_options: {} })],
    [
      "tool choice",
      (f: ReturnType<typeof fixture>) => ({
        ...f.body,
        tool_choice: { type: "function", function: { name: "terminal" } },
      }),
    ],
  ] as const)("rejects %s before persistence or provider I/O", async (_, change) => {
    const f = fixture();
    await expect(f.broker.open(f.request({ body: change(f) }))).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.records).toHaveLength(0);
  });

  it("rejects scope, route, bearer and cancellation before forwarding", async () => {
    const f = fixture();
    for (const override of [
      { path: "/v1/responses" },
      { scope: { ...f.options.scope, leaseFence: 4 } },
      { grant: { ...f.broker.grant, token: "invalid" } },
    ])
      await expect(f.broker.open(f.request(override))).rejects.toThrow();
    f.broker.revoke();
    await expect(f.broker.open(f.request())).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects sanitized name collisions and blocked destinations", () => {
    const f = fixture();
    expect(
      () =>
        new HermesProviderBroker({
          ...f.options,
          tools: [
            { name: "a-b", parameters: {} },
            { name: "a_b", parameters: {} },
          ],
        }),
    ).toThrow();
    expect(
      () =>
        new HermesProviderBroker({
          ...f.options,
          connection: { ...f.options.connection, baseUrl: "http://169.254.169.254/v1" },
        }),
    ).toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("does not forward when started-receipt persistence fails", async () => {
    const f = fixture({
      record: async () => {
        throw new Error("ledger unavailable");
      },
    });
    await expect(f.broker.open(f.request())).rejects.toThrow("could not be admitted");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("counts admitted attempts across a fresh grant and retains unknown reservations", async () => {
    const started: AgentUsage[] = [];
    const record = async (usage: AgentUsage) => {
      if (
        usage.request?.collection?.outcome === "started" &&
        usage.request.counter.sequence === 0
      ) {
        const admission = usage.request.admission!;
        if (
          started.length >= admission.maxRequests ||
          started.reduce((sum, row) => sum + row.request!.admission!.reservedTokens, 0) +
            admission.reservedTokens >
            admission.maxReservedTokens
        )
          throw new Error("exhausted");
        started.push(usage);
      }
    };
    const first = fixture({ maxRequests: 1, maxReservedTokens: 100, record });
    await first.broker.open(first.request());
    const restarted = fixture({ maxRequests: 1, maxReservedTokens: 100, record });
    await expect(restarted.broker.open(restarted.request())).rejects.toThrow(
      "could not be admitted",
    );
    expect(restarted.fetch).not.toHaveBeenCalled();
    expect(started).toHaveLength(1);
  });

  it("records cancellation after a forwarded request", async () => {
    const pendingFetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const f = fixture({ fetch: pendingFetch });
    const pending = f.broker.open(f.request());
    await vi.waitFor(() => expect(pendingFetch).toHaveBeenCalledOnce());
    f.broker.revoke();
    await expect(pending).rejects.toThrow("Provider request failed");
    expect(f.records.at(-1)?.request?.collection?.outcome).toBe("cancelled");
  });
});
