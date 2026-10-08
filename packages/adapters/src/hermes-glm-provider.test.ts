import { hermesProviderFailure } from "@ardurbot/host-runtime/runtimes/hermes-provider-failure";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrokerOptions } from "./hermes-provider-broker.js";
import {
  HermesProviderBroker,
  HermesRelayDispatcher,
  hermesToolName,
  setHermesProviderStream,
} from "./hermes-provider-broker.js";
import { piTools } from "./hermes-provider-translation.js";
import { catalogModels } from "./pi-runtime.js";

const PROMPT = "Test: reply with exactly the words hermes works ok";
const PRIVATE = "private fixture prompt, key and endpoint";
const SUCCESS =
  'data: {"id":"fixture","model":"glm-5.3","choices":[{"index":0,"delta":{"content":"hermes works ok"},"finish_reason":null}]}\n\ndata: {"id":"fixture","model":"glm-5.3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const sse = () => new Response(SUCCESS, { headers: { "content-type": "text/event-stream" } });
const jsonError = (status: number) =>
  new Response(JSON.stringify({ error: { code: "1230", message: PRIVATE } }), {
    status,
    headers: { "content-type": "application/json" },
  });

function fixture(
  purpose: "main" | "summary",
  fetch: typeof globalThis.fetch,
  useDefaultFetch = false,
) {
  const models = catalogModels();
  const model = models.getModel("zai-coding-cn", "glm-5.3")!;
  // Production bridge, not a scripted stream: the bundled SDK constructs the actual wire request.
  setHermesProviderStream((model, context, options) =>
    models.streamSimple(model, context, options),
  );
  if (useDefaultFetch) vi.stubGlobal("fetch", fetch);
  const tools =
    purpose === "main"
      ? Array.from({ length: 56 }, (_, index) => ({
          name: `fixture_tool_${index}`,
          description: "Fixture tool",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string" },
              count: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
              labels: { type: "array", items: { type: "string" } },
              mode: { type: "string", enum: ["safe", "read"] },
            },
            required: ["title"],
            additionalProperties: false,
          },
        }))
      : [];
  const scope: BrokerOptions["scope"] = {
    runId: purpose,
    botId: "bot",
    userId: "user",
    spaceId: "space",
    operationId: "operation",
    leaseOwner: "worker",
    leaseFence: 1,
    hostGeneration: 1,
    configurationHash: "fixture",
    pin: {
      credentialId: "connection",
      provider: model.provider,
      modelId: model.id,
      effort: "high",
    },
  };
  const records: unknown[] = [];
  const broker = new HermesProviderBroker({
    scope,
    credentialId: "connection",
    pinnedEffort: "high",
    connection: {
      credentialId: "connection",
      provider: model.provider,
      modelId: model.id,
      baseUrl: model.baseUrl,
      route: "provider-translated",
      contextWindow: model.contextWindow,
      maxOutputTokens: 65536,
      acceptsImages: false,
      supportsDeveloperRole: false,
      effort: { field: "reasoning_effort", supported: ["high"] },
      reportedModel: "required",
    },
    catalog: { model, apiKey: "fixture-key" },
    tools,
    purpose,
    maxRequests: 5,
    maxReservedTokens: 2147483647,
    expiresAt: Date.now() + 60000,
    active: async () => true,
    record: async (usage) => {
      records.push(usage);
    },
    ...(!useDefaultFetch ? { fetch } : {}),
  });
  const body = {
    model: model.id,
    messages: [
      { role: "system", content: "Use only supplied tools." },
      { role: "user", content: PROMPT },
    ],
    ...(tools.length
      ? {
          tools: tools.map((tool) => ({
            type: "function",
            function: { ...tool, name: hermesToolName(tool.name) },
          })),
        }
      : {}),
    max_tokens: 65536,
    stream: true,
    stream_options: { include_usage: true },
  };
  const request = { grant: broker.grant, scope, path: "/v1/chat/completions", body };
  return { broker, body, request, model, models, tools, records, scope };
}

afterEach(() => vi.unstubAllGlobals());

describe("Hermes GLM bundled-provider wire fixtures", () => {
  it.each(["main", "summary"] as const)(
    "matches the built-in provider wire shape for %s",
    async (purpose) => {
      const wires: unknown[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        expect(String(url)).toBe("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions");
        const wire = JSON.parse(String(init?.body));
        wires.push(wire);
        expect(wire).toMatchObject({
          model: "glm-5.3",
          max_tokens: 65536,
          stream: true,
          stream_options: { include_usage: true },
          thinking: { type: "enabled", clear_thinking: false },
          reasoning_effort: "high",
        });
        expect(wire).not.toHaveProperty("store");
        expect(wire.messages.map((message: { role: string }) => message.role)).toEqual([
          "system",
          "user",
        ]);
        expect(wire.tools?.length ?? 0).toBe(purpose === "main" ? 56 : 0);
        return sse();
      });
      const f = fixture(purpose, fetch);
      const response = await f.broker.open(f.request);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hermes works ok");
      // Independently constructed native context and the same connection/pin.
      const stream = f.models.streamSimple(
        f.model,
        {
          systemPrompt: "Use only supplied tools.",
          messages: [{ role: "user", content: PROMPT, timestamp: 0 }],
          tools: piTools(f.tools.map((tool) => ({ ...tool, name: hermesToolName(tool.name) }))),
        },
        { apiKey: "fixture-key", reasoning: "high", maxTokens: 65536, fetch },
      );
      expect(await stream.result()).toMatchObject({ stopReason: "stop" });
      expect(wires).toHaveLength(2);
      expect(wires[0]).toEqual(wires[1]);
      expect(f.records.at(-1)).toMatchObject({
        request: { purpose, collection: { outcome: "success" } },
      });
    },
  );

  it.each(["main", "summary"] as const)(
    "keeps actual HTTP status and upstream layer for %s",
    async (purpose) => {
      // 403 with non-auth wording used to be manufactured as a relay HTTP 500.
      for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
        const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonError(status));
        const f = fixture(purpose, fetch);
        let caught: unknown;
        try {
          await new HermesRelayDispatcher(
            { broker: f.broker, scope: f.scope },
            new AbortController().signal,
          ).dispatch("provider.open", [f.body]);
        } catch (error) {
          caught = error;
        }
        const failure = hermesProviderFailure(caught);
        expect(failure).toEqual({
          kind: "provider-http",
          status,
          layer: "upstream",
          reason:
            status === 401 || status === 403
              ? "http-auth"
              : status === 429
                ? "http-rate-limit"
                : status >= 500
                  ? "http-server"
                  : "http-client",
        });
        expect(hermesProviderFailure(new Error(String((caught as Error).message)))).toEqual(
          failure,
        );
        expect(String(caught)).not.toContain(PRIVATE);
        expect(f.records.at(-1)).toMatchObject({
          request: { purpose, collection: { outcome: "failed" } },
        });
      }
    },
    60000,
  );

  it("observes the production default fetch and discards HTML error bodies", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(PRIVATE, { status: 500, headers: { "content-type": "text/html" } }),
    );
    const f = fixture("summary", fetch, true);
    await expect(f.broker.open(f.request)).rejects.toMatchObject({
      failure: { kind: "provider-http", status: 500, layer: "upstream", reason: "http-server" },
    });
  }, 60000);

  it("names transport failure without copying the network exception", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error(PRIVATE);
    });
    const f = fixture("main", fetch);
    await expect(f.broker.open(f.request)).rejects.toMatchObject({
      failure: { kind: "provider-failed", layer: "provider-transport", reason: "transport" },
    });
  }, 60000);

  it("does not turn a stream failure after HTTP 200 into an upstream HTTP 500", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"network_error"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const f = fixture("summary", fetch);
    await expect(f.broker.open(f.request)).rejects.toMatchObject({
      failure: { kind: "provider-failed", layer: "upstream", reason: "stream-network" },
    });
  });

  it("does not preserve a failed HTTP attempt after a successful provider retry", async () => {
    let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      ++calls === 1 ? jsonError(500) : sse(),
    );
    const f = fixture("main", fetch);
    setHermesProviderStream((model, context, options) =>
      f.models.streamSimple(model, context, { ...options, maxRetries: 1, maxRetryDelayMs: 1 }),
    );
    const response = await f.broker.open(f.request);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hermes works ok");
    expect(calls).toBe(2);
  });
});
