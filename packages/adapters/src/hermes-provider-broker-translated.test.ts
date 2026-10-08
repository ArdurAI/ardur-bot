import type { AgentUsage } from "@ardurbot/adapter-kit";
import { hermesProviderFailure } from "@ardurbot/host-runtime/runtimes/hermes-provider-failure";
import { startHermesProviderRelay } from "@ardurbot/host-runtime/runtimes/hermes-provider-relay";
import { createLogger, createTestSink } from "@ardurbot/logging";
import type {
  Api,
  AssistantMessageEvent,
  Model,
  Context as PiContext,
  JsonObject as PiJsonObject,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  type BrokerOptions,
  type BrokerRequest,
  HermesProviderBroker,
  HermesRelayDispatcher,
  hermesToolName,
} from "./hermes-provider-broker.js";
import { piContext } from "./hermes-provider-translation.js";

// Key literals are held in constants so the owner-key path stays visible in
// assertions without echoing credential-shaped literals around the fixtures.
const OWNER_KEY = "owner-key";
const GEMINI_OWNER_KEY = "gemini-owner-key";
const SENTINEL_SECRET = "sk-ant-api03-SENTINEL-SECRET-VALUE";
const PASS_THROUGH_KEY = "pass-through-key";

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
      apiKey: PASS_THROUGH_KEY,
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
    scope: options.scope,
    path: "/v1/chat/completions",
    body,
    ...override,
  });
  return { broker, options, request, fetch, records, body };
}

const usage = (input: number, output: number, total = input + output) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: total,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

type FixtureMessage = Extract<AssistantMessageEvent, { type: "done" }>["message"];

const text = (value: string) => ({ type: "text" as const, text: value });

const partial = (content: FixtureMessage["content"] = []) =>
  ({
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fixture",
    usage: usage(0, 0),
    stopReason: "pending",
    timestamp: Date.now(),
  }) as unknown as FixtureMessage;

const startEvent: AssistantMessageEvent = { type: "start", partial: partial() };

function doneEvent(
  content: FixtureMessage["content"],
  stopReason: "stop" | "toolUse" = "stop",
  counts = usage(7, 5),
): AssistantMessageEvent {
  return {
    type: "done",
    reason: stopReason,
    message: {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-fixture",
      usage: counts,
      stopReason,
      timestamp: Date.now(),
    },
  };
}

function textDeltaEvents(value: string): AssistantMessageEvent[] {
  return [
    { type: "text_start", contentIndex: 0, partial: partial() },
    { type: "text_delta", contentIndex: 0, delta: value, partial: partial() },
    { type: "text_end", contentIndex: 0, content: value, partial: partial() },
  ];
}

function toolCallEvents(
  id: string,
  name: string,
  args: Record<string, unknown>,
): AssistantMessageEvent[] {
  const arguments_ = args as PiJsonObject;
  const toolCall = { type: "toolCall" as const, id, name, arguments: arguments_ };
  return [
    {
      type: "toolcall_start",
      contentIndex: 0,
      partial: partial([{ ...toolCall, arguments: {} as PiJsonObject }]),
    },
    {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: JSON.stringify(args),
      partial: partial([{ ...toolCall, arguments: {} as PiJsonObject }]),
    },
    { type: "toolcall_end", contentIndex: 0, toolCall, partial: partial([toolCall]) },
  ];
}

type Captured = {
  model: Model<Api> | undefined;
  context: PiContext;
  options: SimpleStreamOptions | undefined;
};

function scriptedStreamSimple(events: AssistantMessageEvent[], captured: Captured[]) {
  return async (
    model: Model<Api> | undefined,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): Promise<AsyncIterable<AssistantMessageEvent>> => {
    captured.push({ model, context, options });
    const stream = createAssistantMessageEventStream();
    for (const event of events) stream.push(event);
    stream.end();
    return stream;
  };
}

const ANTHROPIC_CATALOG: BrokerOptions["catalog"] = {
  model: {
    id: "claude-fixture",
    name: "Claude Fixture",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  apiKey: OWNER_KEY,
};

const GEMINI_CATALOG: BrokerOptions["catalog"] = {
  model: {
    id: "gemini-fixture",
    name: "Gemini Fixture",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8_192,
  },
  apiKey: GEMINI_OWNER_KEY,
};

/** A broker on the translated route with a scripted provider layer. */
function translatedFixture(
  events: AssistantMessageEvent[],
  patch: Partial<BrokerOptions> & {
    provider?: string;
    modelId?: string;
    catalog?: BrokerOptions["catalog"];
    records?: AgentUsage[];
  } = {},
) {
  const captured: Captured[] = [];
  const records = patch.records ?? [];
  const provider = patch.provider ?? "anthropic";
  const modelId = patch.modelId ?? "claude-fixture";
  const catalog = patch.catalog ?? ANTHROPIC_CATALOG;
  const base = fixture();
  const streamSimple = patch.streamSimple ?? scriptedStreamSimple(events, captured);
  const connection: BrokerOptions["connection"] = {
    ...(patch.connection ?? base.options.connection),
    provider,
    modelId,
    // The translated route never contacts this URL; it carries the provider's
    // documented endpoint for diagnostics only.
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: undefined,
    route: "provider-translated",
  };
  const options: BrokerOptions = {
    ...base.options,
    ...patch,
    connection,
    scope: {
      ...(patch.scope ?? base.options.scope),
      pin: {
        ...(patch.scope ?? base.options.scope).pin,
        provider,
        modelId,
        ...(patch.scope ? { effort: patch.scope.pin.effort } : {}),
      },
    },
    catalog,
    streamSimple,
    record: async (usage) => {
      records.push(usage);
    },
  };
  const broker = new HermesProviderBroker(options);
  const body = { model: modelId, messages: [{ role: "user", content: "hello" }], stream: false };
  const request = (override: Partial<BrokerRequest> = {}): BrokerRequest => ({
    grant: broker.grant,
    scope: options.scope,
    path: "/v1/chat/completions",
    body,
    ...override,
  });
  return { broker, options, request, records, captured, body };
}

function parseFrames(payload: string) {
  return payload
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice(6)));
}

describe("worker provider broker translated route", () => {
  it.each([
    [{ model: "different-model" }, "model"],
    [{ max_tokens: 21 }, "output-tokens"],
    [{ reasoning: { enabled: true, effort: "high" } }, "unknown-field:reasoning"],
    [{ n: 2 }, "unknown-field:n"],
    [{ private_fixture_field: "private value" }, "unknown-field"],
    [{ messages: [] }, "messages"],
    [{ "": "private fixture" }, "unknown-field"],
    [{ tools: [{ type: "function", function: { name: "ungranted", parameters: {} } }] }, "tools"],
    [{ stream: true, stream_options: { include_usage: false } }, "stream-options"],
  ])("reports only the refused field category %s", async (patch, category) => {
    const f = translatedFixture([startEvent, doneEvent([text("completed")])]);
    let caught: unknown;
    try {
      await f.broker.open(f.request({ body: { ...f.body, ...patch } }));
    } catch (error) {
      caught = error;
    }
    expect(hermesProviderFailure(caught)).toEqual({ kind: "grant-refused", category });
    expect(f.captured).toHaveLength(0);
    expect(f.records).toHaveLength(0);
  });

  it("keeps missing required context distinct from a rejected run reservation", async () => {
    const context = translatedFixture([startEvent, doneEvent([text("completed")])], {
      requiredContext: "Required fixture instructions.",
    });
    await expect(context.broker.open(context.request())).rejects.toMatchObject({
      failure: { kind: "grant-refused", category: "context" },
    });
    expect(context.captured).toHaveLength(0);
    const budget = translatedFixture([startEvent, doneEvent([text("completed")])]);
    budget.options.record = async () => {
      throw new Error("private reservation details");
    };
    // Broker copies options at construction; build a new broker with the rejecting recorder.
    const broker = new HermesProviderBroker(budget.options);
    await expect(broker.open(budget.request({ grant: broker.grant }))).rejects.toMatchObject({
      failure: { kind: "grant-refused", category: "run-budget" },
    });
    expect(budget.captured).toHaveLength(0);
  });

  it.each(["main", "summary"] as const)(
    "admits the source-confirmed pinned custom GLM request for %s",
    async (purpose) => {
      const tools =
        purpose === "main"
          ? Array.from({ length: 56 }, (_, index) => ({
              name: `fixture_tool_${index}`,
              description: "Fixture tool",
              parameters: { type: "object", properties: {} },
            }))
          : [];
      const requiredContext = "Use only the supplied tools.";
      const f = translatedFixture(
        [startEvent, ...textDeltaEvents("completed"), doneEvent([text("completed")])],
        {
          provider: "zai",
          modelId: "glm-5.3",
          purpose,
          tools,
          requiredContext,
          maxReservedTokens: 10_000_000,
          catalog: {
            ...ANTHROPIC_CATALOG,
            model: {
              ...ANTHROPIC_CATALOG!.model,
              id: "glm-5.3",
              provider: "zai",
              api: "openai-completions",
              contextWindow: 1_000_000,
              maxTokens: 65_536,
            },
          },
          connection: {
            ...fixture().options.connection,
            contextWindow: 1_000_000,
            maxOutputTokens: 65_536,
          },
        },
      );
      // Pinned custom profile + explicit launcher cap. The loopback route
      // disables extra_body.reasoning; the launcher supplies no reasoning_config.
      const body = {
        model: "glm-5.3",
        messages: [
          { role: "system", content: requiredContext },
          { role: "user", content: "Complete the fixture." },
        ],
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                type: "function",
                function: { ...tool, name: hermesToolName(tool.name) },
              })),
            }
          : {}),
        max_tokens: 65_536,
        stream: true,
        stream_options: { include_usage: true },
      };
      const response = await f.broker.open(f.request({ body }));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("completed");
      expect(f.captured).toHaveLength(1);
      expect(f.captured[0]?.options?.maxTokens).toBe(65_536);
      expect(f.captured[0]?.options?.reasoning).toBe("high");
    },
  );

  it.each(["summary", "main"] as const)(
    "accepts the pinned Hermes streaming usage option for %s turns",
    async (purpose) => {
      const f = translatedFixture(
        [startEvent, ...textDeltaEvents("completed"), doneEvent([text("completed")])],
        {
          purpose,
          tools: [],
        },
      );
      const response = await f.broker.open(
        f.request({
          body: { ...f.body, stream: true, stream_options: { include_usage: true } },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("completed");
      expect(f.captured).toHaveLength(1);
      expect(f.captured[0]?.options).not.toHaveProperty("stream_options");
      expect(f.records.at(-1)?.request?.purpose).toBe(purpose);
    },
  );

  it.each([{ include_usage: false }, { include_usage: true, private: "fixture" }, null, "fixture"])(
    "still refuses unsupported streaming options: %j",
    async (streamOptions) => {
      const f = translatedFixture([startEvent, doneEvent([text("unused")])]);
      await expect(
        f.broker.open(
          f.request({
            body: {
              ...f.body,
              stream: true,
              stream_options: streamOptions,
            },
          }),
        ),
      ).rejects.toMatchObject({ failure: { kind: "grant-refused", category: "stream-options" } });
      expect(f.captured).toHaveLength(0);
      expect(f.records).toHaveLength(0);
    },
  );

  it("refuses a streaming option on a non-streaming request", async () => {
    const f = translatedFixture([startEvent, doneEvent([text("unused")])]);
    await expect(
      f.broker.open(
        f.request({
          body: {
            ...f.body,
            stream: false,
            stream_options: { include_usage: true },
          },
        }),
      ),
    ).rejects.toMatchObject({ failure: { kind: "grant-refused", category: "stream-options" } });
    expect(f.captured).toHaveLength(0);
  });

  it("streams text as Chat Completions SSE with a usage chunk and [DONE]", async () => {
    const f = translatedFixture([
      startEvent,
      ...textDeltaEvents("Bonjour"),
      doneEvent([text("Bonjour")]),
    ]);
    const response = await f.broker.open(f.request({ body: { ...f.body, stream: true } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const payload = await response.text();
    expect(payload.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const frames = parseFrames(payload);
    const first = frames[0];
    expect(first.object).toBe("chat.completion.chunk");
    expect(first.choices[0].delta.role).toBe("assistant");
    const content = frames.map((chunk) => chunk.choices[0]?.delta?.content ?? "").join("");
    expect(content).toBe("Bonjour");
    const finishIndex = frames.findIndex((chunk) => chunk.choices[0]?.finish_reason === "stop");
    expect(finishIndex).toBe(frames.length - 2);
    expect(frames[finishIndex].usage).toBeUndefined();
    const usageIndex = frames.findIndex((chunk) => chunk.usage);
    expect(usageIndex).toBe(frames.length - 1);
    expect(finishIndex).toBeLessThan(usageIndex);
    const usageFrame = frames[usageIndex];
    expect(usageFrame.choices).toEqual([]);
    expect(usageFrame.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 5,
      total_tokens: 12,
    });
    expect(f.records.at(-1)?.request?.collection?.outcome).toBe("success");
    expect(f.records.at(-1)?.request?.categories).toMatchObject({
      logicalInput: 7,
      output: 5,
    });
    expect(f.records[0]?.request?.admission).toMatchObject({
      reservedTokens: expect.any(Number),
      maxRequests: 2,
    });
  });

  it("returns one Chat Completions JSON body for a non-streaming request", async () => {
    const f = translatedFixture([
      startEvent,
      ...textDeltaEvents("Salut"),
      doneEvent([text("Salut")]),
    ]);
    const response = await f.broker.open(f.request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(await response.text());
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("claude-fixture");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Salut");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 5,
      total_tokens: 12,
    });
  });

  it("maps a tool definition and a tool call round trip", async () => {
    const toolName = hermesToolName("fixture_echo");
    const f = translatedFixture([
      startEvent,
      ...toolCallEvents("call_1", toolName, { phrase: "hi" }),
      doneEvent([], "toolUse", usage(11, 3)),
    ]);
    const first = await f.broker.open(
      f.request({
        body: {
          model: "claude-fixture",
          messages: [{ role: "user", content: "echo hi" }],
          tools: [{ type: "function", function: { name: toolName, parameters: {} } }],
          stream: false,
        },
      }),
    );
    expect(f.captured[0]!.context.tools?.map((tool) => tool.name)).toEqual([toolName]);
    expect(f.captured[0]!.context.tools?.[0]?.description).toBe("Echo");
    expect(first.status).toBe(200);
    const firstBody = JSON.parse(await first.text());
    expect(firstBody.choices[0].finish_reason).toBe("tool_calls");
    expect(firstBody.choices[0].message.tool_calls).toEqual([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: toolName, arguments: '{"phrase":"hi"}' },
      },
    ]);

    // Round trip: assistant tool_call -> tool result -> final text.
    const second = translatedFixture([
      startEvent,
      ...textDeltaEvents("hi"),
      doneEvent([text("hi")], "stop", usage(13, 2)),
    ]);
    const response = await second.broker.open(
      second.request({
        body: {
          model: "claude-fixture",
          messages: [
            { role: "user", content: "echo hi" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: toolName, arguments: '{"phrase":"hi"}' },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_1", content: "hi" },
          ],
          stream: false,
        },
      }),
    );
    const replayed = second.captured[0]!.context;
    expect(replayed.messages[0]).toEqual({
      role: "user",
      content: "echo hi",
      timestamp: 1,
    });
    expect(replayed.messages[1]).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: toolName, arguments: { phrase: "hi" } }],
      }),
    );
    expect(replayed.messages[2]).toEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call_1",
        toolName,
        content: [{ type: "text", text: "hi" }],
      }),
    );
    const secondBody = JSON.parse(await response.text());
    expect(secondBody.choices[0].message.content).toBe("hi");
    expect(secondBody.choices[0].finish_reason).toBe("stop");
  });

  it("streams tool call arguments exactly once in SSE for both fragment and end-only cases", async () => {
    const toolName = hermesToolName("fixture_echo");

    // 1. Fragment case: arguments streamed via deltas then ended
    const fragmentStream = translatedFixture([
      startEvent,
      {
        type: "toolcall_start",
        contentIndex: 0,
        partial: partial([
          { type: "toolCall", id: "call_1", name: toolName, arguments: {} as PiJsonObject },
        ]),
      },
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"phrase":',
        partial: partial([
          { type: "toolCall", id: "call_1", name: toolName, arguments: {} as PiJsonObject },
        ]),
      },
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '"hi"}',
        partial: partial([
          { type: "toolCall", id: "call_1", name: toolName, arguments: {} as PiJsonObject },
        ]),
      },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "call_1", name: toolName, arguments: { phrase: "hi" } },
        partial: partial([
          { type: "toolCall", id: "call_1", name: toolName, arguments: { phrase: "hi" } },
        ]),
      },
      doneEvent([], "toolUse"),
    ]);

    const fragmentResp = await fragmentStream.broker.open(
      fragmentStream.request({
        body: {
          model: "claude-fixture",
          messages: [{ role: "user", content: "echo hi" }],
          tools: [{ type: "function", function: { name: toolName, parameters: {} } }],
          stream: true,
        },
      }),
    );
    expect(fragmentResp.status).toBe(200);
    const fragmentFrames = parseFrames(await fragmentResp.text());
    const fragmentArgs = fragmentFrames
      .flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? [])
      .map((call) => call.function?.arguments ?? "")
      .join("");
    expect(fragmentArgs).toBe('{"phrase":"hi"}');
    const fragmentFinish = fragmentFrames.find(
      (chunk) => chunk.choices[0]?.finish_reason === "tool_calls",
    );
    expect(fragmentFinish).toBeDefined();

    // 2. End-only case: no delta events, arguments given only at toolcall_end
    const endOnlyStream = translatedFixture([
      startEvent,
      {
        type: "toolcall_start",
        contentIndex: 0,
        partial: partial([
          { type: "toolCall", id: "call_2", name: toolName, arguments: {} as PiJsonObject },
        ]),
      },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          id: "call_2",
          name: toolName,
          arguments: { phrase: "end-only" },
        },
        partial: partial([
          { type: "toolCall", id: "call_2", name: toolName, arguments: { phrase: "end-only" } },
        ]),
      },
      doneEvent([], "toolUse"),
    ]);

    const endOnlyResp = await endOnlyStream.broker.open(
      endOnlyStream.request({
        body: {
          model: "claude-fixture",
          messages: [{ role: "user", content: "echo end-only" }],
          tools: [{ type: "function", function: { name: toolName, parameters: {} } }],
          stream: true,
        },
      }),
    );
    expect(endOnlyResp.status).toBe(200);
    const endOnlyFrames = parseFrames(await endOnlyResp.text());
    const endOnlyArgs = endOnlyFrames
      .flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? [])
      .map((call) => call.function?.arguments ?? "")
      .join("");
    expect(endOnlyArgs).toBe('{"phrase":"end-only"}');
    const endOnlyFinish = endOnlyFrames.find(
      (chunk) => chunk.choices[0]?.finish_reason === "tool_calls",
    );
    expect(endOnlyFinish).toBeDefined();
  });

  it("preserves empty or absent tool results in multi-turn conversation with a void tool", async () => {
    const toolName = hermesToolName("fixture_void");
    const f = translatedFixture(
      [
        startEvent,
        ...textDeltaEvents("completed void action"),
        doneEvent([text("completed void action")]),
      ],
      {
        tools: [{ name: "fixture_void", description: "Void tool", parameters: { type: "object" } }],
      },
    );

    const response = await f.broker.open(
      f.request({
        body: {
          model: "claude-fixture",
          messages: [
            { role: "user", content: "run void action" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_void_1",
                  type: "function",
                  function: { name: toolName, arguments: "{}" },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_void_1", content: "" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_void_2",
                  type: "function",
                  function: { name: toolName, arguments: "{}" },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_void_2" },
          ],
          stream: false,
        },
      }),
    );
    expect(response.status).toBe(200);
    const replayed = f.captured[0]!.context;
    expect(replayed.messages).toHaveLength(5);
    expect(replayed.messages[2]).toEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call_void_1",
        toolName,
        content: [{ type: "text", text: "" }],
        isError: false,
      }),
    );
    expect(replayed.messages[4]).toEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call_void_2",
        toolName,
        content: [{ type: "text", text: "" }],
        isError: false,
      }),
    );
    const body = JSON.parse(await response.text());
    expect(body.choices[0].message.content).toBe("completed void action");
  });

  it("translates a data-URL image into the provider-layer image type", async () => {
    const f = translatedFixture([
      startEvent,
      ...textDeltaEvents("seen"),
      doneEvent([text("seen")]),
    ]);
    await f.broker.open(
      f.request({
        body: {
          model: "claude-fixture",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is this" },
                { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
              ],
            },
          ],
          stream: false,
        },
      }),
    );
    expect(f.captured[0]!.context.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      timestamp: 1,
    });
  });

  it.each([
    ["main", false],
    ["main", true],
    ["summary", false],
    ["summary", true],
  ] as const)(
    "returns safe 400 JSON through the real relay for %s remote images (stream %s)",
    async (purpose, stream) => {
      const fetchSpy = vi.fn();
      const f = translatedFixture([startEvent, doneEvent([text("unused")])], {
        purpose,
        fetch: fetchSpy,
      });
      const dispatcher = new HermesRelayDispatcher(
        { broker: f.broker, scope: f.options.scope },
        new AbortController().signal,
      );
      const sink = createTestSink();
      const logger = createLogger({ service: "fixture", sinks: [sink], level: "info" });
      const failed = vi.fn();
      const relay = await startHermesProviderRelay(
        { ...f.broker.grant, protocol: 1, hostGeneration: "fixture" },
        async (method, args) => {
          try {
            return await dispatcher.dispatch(method, args);
          } catch (error) {
            throw new Error((error as Error).message);
          }
        },
        failed,
        logger,
      );
      try {
        const response = await fetch(`${relay.url}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${f.broker.grant.token}` },
          body: JSON.stringify({
            model: "claude-fixture",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "private fixture prompt" },
                  {
                    type: "image_url",
                    image_url: { url: "https://example.com/private-fixture.png" },
                  },
                ],
              },
            ],
            stream,
          }),
        });
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(await response.json()).toEqual({
          error: {
            message: "Provider request failed.",
            type: "invalid_request_error",
            code: 400,
          },
        });
        expect(failed).toHaveBeenCalledExactlyOnceWith({
          kind: "provider-failed",
          layer: "translation",
          reason: "request-translation",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(f.captured).toHaveLength(0);
        expect(f.records.map((entry) => entry.request?.collection?.outcome)).toEqual([
          "started",
          "failed",
        ]);
        const logged = JSON.stringify(sink.events);
        expect(logged).toContain("request-translation");
        expect(logged).not.toContain("private");
        expect(logged).not.toContain("example.com");
        expect(logged).not.toContain(f.broker.grant.token);
      } finally {
        relay.close();
      }
    },
  );

  it("names request translation for remote image URLs without fetching", async () => {
    const fetchSpy = vi.fn();
    const f = translatedFixture([startEvent, doneEvent([text("should not reach")])], {
      fetch: fetchSpy,
    });
    await expect(
      f.broker.open(
        f.request({
          body: {
            model: "claude-fixture",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "what is this" },
                  { type: "image_url", image_url: { url: "https://example.com/remote.png" } },
                ],
              },
            ],
            stream: false,
          },
        }),
      ),
    ).rejects.toMatchObject({
      failure: { kind: "provider-failed", layer: "translation", reason: "request-translation" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(f.captured).toHaveLength(0);

    expect(() =>
      piContext({
        model: ANTHROPIC_CATALOG.model!,
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.com/remote.png" } }],
          },
        ],
        allowedTools: new Map(),
      }),
    ).toThrow("Only inline images are supported.");
  });

  it("maps the pinned reasoning effort to the provider-layer thinking level", async () => {
    const base = fixture();
    const f = translatedFixture([startEvent, ...textDeltaEvents("ok"), doneEvent([text("ok")])], {
      pinnedEffort: "high",
      connection: {
        ...base.options.connection,
        effort: { field: "reasoning_effort", supported: ["off", "high"] },
      },
      scope: {
        ...base.options.scope,
        pin: { ...base.options.scope.pin, effort: "high" },
      },
    });
    await f.broker.open(f.request());
    expect(f.captured[0]?.options?.reasoning).toBe("high");
    expect(f.captured[0]?.options?.apiKey).toBe(OWNER_KEY);
    expect(f.captured[0]?.options?.maxTokens).toBe(20);

    const off = translatedFixture([startEvent, ...textDeltaEvents("ok"), doneEvent([text("ok")])], {
      pinnedEffort: "off",
      connection: {
        ...base.options.connection,
        effort: { field: "none", supported: ["off"] },
      },
      scope: {
        ...base.options.scope,
        pin: { ...base.options.scope.pin, effort: "off" },
      },
    });
    await off.broker.open(off.request());
    expect(off.captured[0]?.options?.reasoning).toBeUndefined();
  });

  it("maps a Gemini-style event stream into SSE and accounting", async () => {
    const base = fixture();
    const f = translatedFixture(
      [startEvent, ...textDeltaEvents("Ciao"), doneEvent([text("Ciao")], "stop", usage(3, 4, 9))],
      {
        provider: "google",
        modelId: "gemini-fixture",
        catalog: GEMINI_CATALOG,
        connection: { ...base.options.connection, acceptsImages: false },
      },
    );
    const response = await f.broker.open(
      f.request({
        body: {
          model: "gemini-fixture",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
      }),
    );
    expect(response.status).toBe(200);
    const usageFrame = parseFrames(await response.text()).find((chunk) => chunk.usage);
    expect(usageFrame.choices).toEqual([]);
    expect(usageFrame.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 9,
    });
    expect(f.captured[0]?.options?.apiKey).toBe(GEMINI_OWNER_KEY);
    expect(f.records.at(-1)?.request?.categories).toMatchObject({ logicalInput: 3, output: 4 });
  });

  it("refuses an over-cap request before any provider call", async () => {
    const f = translatedFixture([startEvent, doneEvent([text("no")])]);
    await expect(
      f.broker.open(f.request({ body: { ...f.body, max_completion_tokens: 21 } })),
    ).rejects.toThrow();
    expect(f.captured).toHaveLength(0);
    expect(f.records).toHaveLength(0);
  });

  it("refuses a revoked grant before any provider call", async () => {
    const f = translatedFixture([startEvent, doneEvent([text("no")])]);
    f.broker.revoke();
    await expect(f.broker.open(f.request())).rejects.toThrow();
    expect(f.captured).toHaveLength(0);
    expect(f.records).toHaveLength(0);
  });

  it("does not infer HTTP status from private stream exception text", async () => {
    const failingStream = async () => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [],
        api: "anthropic-messages" as const,
        provider: "anthropic",
        model: "claude-fixture",
        usage: usage(0, 0),
        stopReason: "error" as const,
        errorMessage: `invalid x-api-key ${SENTINEL_SECRET}`,
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
      return stream;
    };
    const f = translatedFixture([], { streamSimple: failingStream as never });
    let caught: unknown;
    try {
      await f.broker.open(f.request());
    } catch (error) {
      caught = error;
    }
    expect(hermesProviderFailure(caught)).toEqual({
      kind: "provider-failed",
      layer: "provider-adapter",
      reason: "provider-stream",
    });
    expect(String(caught)).not.toContain(SENTINEL_SECRET);
    expect(f.records.at(-1)?.request?.collection?.outcome).toBe("failed");
  });

  it("never lets a request-sourced key reach the provider layer", async () => {
    const f = translatedFixture([startEvent, doneEvent([text("ok")])]);
    const opened = await f.broker
      .open(
        f.request({
          body: {
            model: "claude-fixture",
            messages: [{ role: "user", content: "hi" }],
            api_key_hint: "attacker-key",
          } as never,
        }),
      )
      .catch((error: unknown) => error);
    // Unknown body fields are denied by admission before any provider call.
    expect(opened).toBeInstanceOf(Error);
    expect(f.captured).toHaveLength(0);
  });

  it("keeps the openai-compatible pass-through bytes and headers unchanged", async () => {
    const f = fixture();
    const response = await f.broker.open(
      f.request({ body: { ...f.body, messages: [{ role: "user", content: "byte for byte" }] } }),
    );
    expect(response.status).toBe(200);
    expect(f.fetch).toHaveBeenCalledOnce();
    const call = f.fetch.mock.calls[0]!;
    expect(String(call[0])).toBe("http://127.0.0.1:1/v1/chat/completions");
    const init = call[1]!;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${PASS_THROUGH_KEY}`,
    });
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({
      model: "fixture-model",
      messages: [{ role: "user", content: "byte for byte" }],
      tools: [
        {
          type: "function",
          function: {
            name: hermesToolName("fixture_echo"),
            description: "Echo",
            parameters: { type: "object" },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: hermesToolName("fixture_echo") } },
      stream: false,
      max_tokens: 20,
      reasoning_effort: "high",
    });
  });

  it("keeps the Ollama pass-through path on the openai-completions route", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ model: "llama-fixture", usage: { prompt_tokens: 4, completion_tokens: 6 } }),
    );
    const f = fixture({
      fetch,
      connection: {
        credentialId: "connection",
        provider: "ollama",
        modelId: "llama-fixture",
        baseUrl: "http://127.0.0.1:11434/v1",
        route: "openai-completions",
        contextWindow: 80,
        maxOutputTokens: 20,
        acceptsImages: true,
        supportsDeveloperRole: false,
        effort: { field: "none", supported: ["off"] },
        reportedModel: "required",
      },
      scope: {
        ...fixture().options.scope,
        pin: {
          credentialId: "connection",
          provider: "ollama",
          modelId: "llama-fixture",
          effort: "off",
        },
      },
      pinnedEffort: "off",
    });
    const response = await f.broker.open(
      f.request({
        body: {
          model: "llama-fixture",
          messages: [{ role: "user", content: "local" }],
          stream: false,
        },
      }),
    );
    expect(response.status).toBe(200);
    const call = fetch.mock.calls[0]!;
    expect(String(call[0])).toBe("http://127.0.0.1:11434/v1/chat/completions");
    const init = call[1]!;
    expect(init.headers).toEqual({ "content-type": "application/json" });
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe("llama-fixture");
    expect(sent.max_tokens).toBe(20);
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(f.records.at(-1)?.request?.collection?.outcome).toBe("success");
  });
});
