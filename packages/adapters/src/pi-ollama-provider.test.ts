import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { modelsForRequest, PiAgentRuntime, resolveRuntimeModel } from "./pi-runtime.js";

const model = {
  provider: "ollama",
  id: "qwen3:8b",
  baseUrl: "http://127.0.0.1:11434/v1",
  contextWindow: 40960,
  reasoning: true,
  apiKey: "local",
};

describe("Ollama OpenAI transport", () => {
  it.each(["off", "low", "medium", "high"] as const)(
    "sends %s as binary thinking over /v1",
    async (effort) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        expect(String(url)).toBe("http://127.0.0.1:11434/v1/chat/completions");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "qwen3:8b",
          reasoning_effort: effort === "off" ? "none" : "medium",
        });
        return new Response(
          'data: {"id":"test","choices":[{"delta":{"content":"Done"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const models = modelsForRequest({ model }, "ollama");
      const concrete = models.getModel("ollama", model.id)!;
      const stream = models.streamSimple(
        concrete,
        { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
        { apiKey: "local", reasoning: effort === "off" ? undefined : effort, fetch },
      );
      expect(await stream.result()).toMatchObject({ stopReason: "stop" });
      expect(fetch).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
        model: "qwen3:8b",
        reasoning_effort: effort === "off" ? "none" : "medium",
      });
    },
  );
  it("fails before inference when a text-only model receives an image", async () => {
    const request: AgentRunRequest = {
      botId: "bot",
      threadId: "thread",
      runId: "run",
      instructions: "",
      prompt: "image",
      history: [],
      tools: [],
      model: { ...model, reasoning: false, thinkingLevel: "off" },
      currentTurnImages: [
        { name: "image.png", data: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
      ],
    };
    await expect(
      (async () => {
        for await (const _ of new PiAgentRuntime().run(request)) {
          /* Drain. */
        }
      })(),
    ).rejects.toThrow("This model does not accept images.");
  });
  it("never searches hosted catalogs when an Ollama registration is missing", () => {
    expect(
      resolveRuntimeModel({ provider: "ollama", id: "openai/gpt-5.6-luna" }).model,
    ).toBeUndefined();
  });
});
