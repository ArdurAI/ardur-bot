import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));

// The fake agent makes the one provider request a turn starts with.
vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    constructor(
      private readonly options: {
        sessionId?: string;
        streamFn: (model: unknown, context: unknown, options: unknown) => unknown;
        initialState: { model: unknown; systemPrompt: string; messages: unknown[] };
      },
    ) {}
    subscribe() {}
    async prompt() {
      const { model, systemPrompt, messages } = this.options.initialState;
      this.options.streamFn(
        model,
        { systemPrompt, messages },
        { sessionId: this.options.sessionId },
      );
    }
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => ({
      provider,
      id,
      api: provider === "anthropic" ? "anthropic-messages" : "openai-responses",
      reasoning: false,
      input: ["text"],
      maxTokens: 4_096,
      contextWindow: 200_000,
    }),
    streamSimple: (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
      provider.options.push(options);
      return { async *[Symbol.asyncIterator]() {}, result: async () => ({}) };
    },
  }),
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime, promptCacheOptions, stableHistoryEnd } from "./pi-runtime.js";

const turn: AgentRunRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  instructions: "Coordinate the launch.",
  stablePrefix: "Coordinate the launch.",
  history: [
    { role: "user", content: "<thread_summary>\nFriday launch.\n</thread_summary>" },
    { id: "u1", role: "user", content: "Where is the checklist?" },
    { id: "b1", role: "assistant", content: "Nine items are done." },
    { role: "user", content: "<teammate_directory>\nWriter · busy\n</teammate_directory>" },
  ],
  stableHistory: 3,
  prompt: "What is still open?",
  tools: "none",
  model: { provider: "anthropic", id: "fixture-model", apiKey: "fixture-key" },
};

async function providerOptions(request: AgentRunRequest) {
  provider.options.length = 0;
  for await (const _event of new PiAgentRuntime().run(request, {
    operationId: "op",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    // Drain the turn.
  }
  expect(provider.options).toHaveLength(1);
  return provider.options[0]!;
}

describe("pi prompt cache options", () => {
  beforeEach(() => {
    provider.options.length = 0;
  });

  it("sends one-shot requests without a prompt-cache write on every provider", async () => {
    for (const model of [
      { provider: "anthropic", id: "fixture-model", apiKey: "fixture-key" },
      { provider: "openai", id: "fixture-model", apiKey: "fixture-key" },
    ]) {
      const options = await providerOptions({ ...turn, model, singleRequest: true });
      expect(options.cacheRetention).toBe("none");
      expect(options.onPayload).toBeUndefined();
    }
  });

  it("keeps the default cache for conversation turns and marks what repeats", async () => {
    const openai = await providerOptions({
      ...turn,
      model: { provider: "openai", id: "fixture-model", apiKey: "fixture-key" },
    });
    expect(openai.cacheRetention).toBeUndefined();
    expect(openai.sessionId).toBe("thread:bot");

    const anthropic = await providerOptions(turn);
    expect(anthropic.cacheRetention).toBeUndefined();
    const marker = { type: "ephemeral" };
    const payload = {
      system: [{ type: "text", text: "Coordinate the launch.", cache_control: marker }],
      messages: [
        { role: "user", content: "<thread_summary>\nFriday launch.\n</thread_summary>" },
        { role: "user", content: "Where is the checklist?" },
        { role: "user", content: "Assistant: Nine items are done." },
        { role: "user", content: "<teammate_directory>\nWriter · busy\n</teammate_directory>" },
        {
          role: "user",
          content: [{ type: "text", text: "What is still open?", cache_control: marker }],
        },
      ],
    };
    const onPayload = anthropic.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;
    expect(((await onPayload(payload, {})) as typeof payload).messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Assistant: Nine items are done.", cache_control: marker }],
    });
  });

  it("chains the agent's own payload hook before placing markers", async () => {
    const options = promptCacheOptions(
      { api: "anthropic-messages" },
      { onPayload: (payload) => ({ ...(payload as object), system: "Coordinate the launch." }) },
      { stablePrefix: "Coordinate the launch." },
    );
    expect(await options.onPayload?.({ system: "draft" }, {} as never)).toEqual({
      system: [
        { type: "text", text: "Coordinate the launch.", cache_control: { type: "ephemeral" } },
      ],
    });
    expect(promptCacheOptions({ api: "anthropic-messages" }, undefined, {})).toEqual({});
  });

  it("finds where the stable history ends among the messages a provider receives", () => {
    expect(stableHistoryEnd(turn, turn.history)).toEqual({
      index: 2,
      text: "Assistant: Nine items are done.",
    });
    // Providers drop blank messages, so they do not shift the position.
    const blank = { ...turn, history: [{ role: "user" as const, content: " " }, ...turn.history] };
    expect(stableHistoryEnd({ ...blank, stableHistory: 4 }, blank.history)).toEqual({
      index: 2,
      text: "Assistant: Nine items are done.",
    });
    // A message delivered as steering leaves the history, so the end moves back one message.
    const steering = {
      ...turn,
      history: [
        ...turn.history.slice(0, 3),
        { id: "u2", role: "user" as const, content: "Also check the invite." },
        ...turn.history.slice(3),
      ],
      stableHistory: 4,
    };
    expect(
      stableHistoryEnd(
        steering,
        steering.history.filter((message) => message.id !== "u2"),
      ),
    ).toEqual({ index: 2, text: "Assistant: Nine items are done." });
    expect(stableHistoryEnd({ ...turn, stableHistory: 0 }, turn.history)).toBeUndefined();
    expect(stableHistoryEnd({ ...turn, stableHistory: undefined }, turn.history)).toBeUndefined();
  });
});
