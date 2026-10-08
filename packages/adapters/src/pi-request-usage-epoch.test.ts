import type { AgentRunRequest, AgentUsage } from "@ardurbot/adapter-kit";
import { RequestUsageCollector } from "@ardurbot/adapter-kit";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPiWireSnapshot, observePiUsage } from "./pi-request-usage.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { accumulateRequestUsage } from "./request-usage.js";
import { accountRuntimeUsage, ObservedUsageTotals } from "./runtime-usage.js";
import { dispatcherFetch } from "./undici-fetch.js";

vi.mock("./undici-fetch.js", () => ({ dispatcherFetch: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

const model: Model<Api> = {
  id: "fixture-model",
  name: "Fixture",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

describe("Pi wire counter boundaries", () => {
  it("keeps the Kimi coding Anthropic path running across two turns of one bot", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const runtime = new PiAgentRuntime();
    const requests: string[] = [];
    for (const input of [1200, 300]) {
      const payloads = [
        {
          type: "message_start",
          message: {
            id: "fixture-message",
            type: "message",
            role: "assistant",
            model: "kimi-for-coding",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: input,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "fixture answer" },
        },
        { type: "content_block_stop", index: 0 },
        ...(input === 300
          ? [
              {
                type: "message_delta",
                delta: { stop_reason: null, stop_sequence: null },
                usage: { input_tokens: 200, output_tokens: 10 },
              },
            ]
          : []),
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: input === 300 ? 310 : input, output_tokens: 20 },
        },
        { type: "message_stop" },
      ];
      fetch.mockResolvedValueOnce(
        new Response(
          payloads
            .map((payload) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
      const usages: AgentUsage[] = [];
      const totals = new ObservedUsageTotals();
      const request: AgentRunRequest = {
        botId: "fixture-bot",
        threadId: "fixture-thread",
        runId: crypto.randomUUID(),
        prompt: "Complete the fixture.",
        instructions: "Use the fixture.",
        history: [],
        tools: "none",
        model: {
          provider: "kimi-coding",
          id: "kimi-for-coding",
          apiKey: "fixture-key",
          thinkingLevel: "high",
        },
      };
      const events = [];
      for await (const event of accountRuntimeUsage(runtime.run(request), {
        provider: request.model.provider,
        model: request.model.id,
        record: async (usage) => {
          usages.push(usage);
        },
        totals,
      }))
        events.push(event);
      expect(events.at(-1)).toEqual({ type: "done", text: "fixture answer" });
      expect(totals.tokens).toBe(input + (input === 1200 ? 20 : 30));
      expect(usages.at(-1)?.request?.collection).toMatchObject({
        outcome: "success",
        mappingVersion: "pi-anthropic-messages-wire-v1",
        limitations: input === 1200 ? [] : ["counter-discontinuity"],
      });
      expect(new Set(usages.map((usage) => usage.request?.counter.epochId)).size).toBe(1);
      requests.push(usages[0]!.request!.requestId);
    }
    expect(new Set(requests).size).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("accounts two runs of one bot through the Pi SDK without a live connection", async () => {
    const runtime = new PiAgentRuntime();
    const calls: AgentUsage[][] = [];
    for (const input of [1200, 300]) {
      const payloads = [
        {
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "fixture answer" },
              finish_reason: null,
            },
          ],
        },
        ...(input === 1200 ? [input] : [input, input - 100, input + 10]).map((prompt_tokens) => ({
          choices: [],
          usage: { prompt_tokens, completion_tokens: 20 },
        })),
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      vi.mocked(dispatcherFetch).mockResolvedValueOnce(
        new Response(
          payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
      const request: AgentRunRequest = {
        botId: "fixture-bot",
        threadId: "fixture-thread",
        runId: crypto.randomUUID(),
        prompt: "Complete the fixture.",
        instructions: "Use the fixture.",
        history: [],
        tools: "none",
        model: {
          provider: "openai-compatible",
          id: "fixture-model",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "fixture-key",
          contextWindow: 8192,
          maxTokens: 1024,
        },
      };
      const usages: AgentUsage[] = [];
      const totals = new ObservedUsageTotals();
      const events = [];
      for await (const event of accountRuntimeUsage(runtime.run(request), {
        provider: request.model.provider,
        model: request.model.id,
        record: async (usage) => {
          usages.push(usage);
        },
        totals,
      }))
        events.push(event);
      expect(events.at(-1)).toEqual({ type: "done", text: "fixture answer" });
      expect(totals.tokens).toBe(input + (input === 1200 ? 20 : 30));
      expect(usages.at(-1)?.request?.collection?.outcome).toBe("success");
      expect(new Set(usages.map((usage) => usage.request?.requestId)).size).toBe(1);
      expect(new Set(usages.map((usage) => usage.request?.counter.epochId)).size).toBe(1);
      calls.push(usages);
    }
    expect(calls[0]![0]!.request?.requestId).not.toBe(calls[1]![0]!.request?.requestId);
    expect(calls[0]![0]!.request?.counter.epochId).not.toBe(calls[1]![0]!.request?.counter.epochId);
    expect(dispatcherFetch).toHaveBeenCalledTimes(2);
  });

  it("completes consecutive calls with fresh identities and a falling in-stream counter", async () => {
    const calls: AgentUsage[][] = [];
    // This is the streamFn wrapper used on every model call, with no network or SDK mocking.
    for (const input of [1200, 300]) {
      const usages: AgentUsage[] = [];
      const totals = new ObservedUsageTotals();
      const body = (input === 1200 ? [input] : [input, input - 100, input - 50, input + 10])
        .map(
          (prompt_tokens) =>
            `data: ${JSON.stringify({
              usage: { prompt_tokens, completion_tokens: 20 },
            })}\n\n`,
        )
        .join("");
      const stream = observePiUsage(
        model,
        {
          fetch: async () =>
            new Response(body, { headers: { "content-type": "text/event-stream" } }),
        },
        (options) => {
          const source = createAssistantMessageEventStream();
          void (async () => {
            try {
              const response = await options.fetch!(model.baseUrl);
              await response.text();
              const message: AssistantMessage = {
                role: "assistant",
                content: [{ type: "text", text: "fixture answer" }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: 0,
              };
              source.push({ type: "done", reason: "stop", message });
              source.end(message);
            } catch {
              const error: AssistantMessage = {
                role: "assistant",
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "error",
                errorMessage: "Fixture read failed.",
                timestamp: 0,
              };
              source.push({ type: "error", reason: "error", error });
              source.end(error);
            }
          })();
          return source;
        },
        (usage) => {
          usages.push(usage);
        },
      );
      const events = [];
      for await (const event of stream) events.push(event);
      expect(events.at(-1)?.type).toBe("done");
      expect((await stream.result()).content).toEqual([{ type: "text", text: "fixture answer" }]);
      for (const usage of usages) totals.observe(usage);
      expect(totals.tokens).toBe(input + (input === 1200 ? 20 : 30));
      expect(new Set(usages.map((usage) => usage.request?.counter.epochId)).size).toBe(1);
      expect(new Set(usages.map((usage) => usage.request?.attemptId))).toEqual(new Set(["0"]));
      expect(usages.at(-1)?.request?.collection).toMatchObject({
        outcome: "success",
        limitations: input === 1200 ? [] : ["counter-discontinuity"],
      });
      if (input === 300) {
        expect(usages[2]?.request?.collection?.raw.input).toBe(input - 100);
        // The lower raw report is evidence, not a reset or a second bill.
        expect(usages[2]?.request?.categories.logicalInput).toBe(input);
      }
      calls.push(usages);
    }
    expect(calls[0]![0]!.request?.requestId).not.toBe(calls[1]![0]!.request?.requestId);
    expect(calls[0]![0]!.request?.counter.epochId).not.toBe(calls[1]![0]!.request?.counter.epochId);
  });

  it("keeps the last consistent cache partition and marks it as a lower bound", () => {
    const collector = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture-model",
      mappingVersion: "pi-openai-completions-wire-v1",
      inputSemantics: "total-with-cache-subsets",
    });
    const counts = {};
    let totals = accumulateRequestUsage(null, collector.start().request!);
    for (const cached_tokens of [20, 50]) {
      const usage = applyPiWireSnapshot(
        collector,
        "openai-completions",
        {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens, cache_write_tokens: 0 },
          },
        },
        counts,
      )!;
      totals = accumulateRequestUsage(totals, usage.request!);
    }
    expect(totals.categories).toMatchObject({
      logicalInput: 100,
      uncachedInput: 80,
      cacheReadInput: 20,
    });
    expect(totals.categoryCoverage.logicalInput).toBe("partial");
    expect(collector.finish("success").request?.collection?.limitations).toContain(
      "counter-discontinuity",
    );
  });

  it("does not replace the last valid snapshot with malformed wire counts", () => {
    const collector = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture-model",
      mappingVersion: "pi-openai-completions-wire-v1",
      inputSemantics: "total-with-cache-subsets",
    });
    const counts = {};
    let totals = accumulateRequestUsage(null, collector.start().request!);
    for (const prompt_tokens of [100, -1, 80]) {
      const usage = applyPiWireSnapshot(
        collector,
        "openai-completions",
        {
          usage: { prompt_tokens, completion_tokens: 10 },
        },
        counts,
      )!;
      totals = accumulateRequestUsage(totals, usage.request!);
    }
    expect(totals.categories.logicalInput).toBe(100);
    expect(totals.categoryCoverage.logicalInput).toBe("partial");
  });
});
