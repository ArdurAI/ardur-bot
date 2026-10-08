import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import { expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const agents: Array<{ aborted: boolean }> = [];
  class Agent {
    state = { messages: [] as unknown[], errorMessage: undefined };
    aborted = false;
    listener?: (event: unknown) => Promise<void>;
    constructor(_options: unknown) {
      agents.push(this);
    }
    subscribe(listener: (event: unknown) => Promise<void>) {
      this.listener = listener;
    }
    abort() {
      this.aborted = true;
    }
    async prompt() {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "saved response" }],
        stopReason: "stop",
      };
      this.state.messages.push(message);
      await this.listener?.({ type: "message_end", message });
    }
    async waitForIdle() {}
  }
  return { Agent, agents };
});
vi.mock("@earendil-works/pi-agent-core", () => ({ Agent: fake.Agent }));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({ getModel: () => ({ provider: "test", id: "fake-model" }) }),
}));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

it("awaits a durable model boundary before stopping the runtime for restart", async () => {
  let finish!: () => void;
  const saved = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const saveCheckpoint = vi.fn(async (_state: unknown) => {
    await saved;
    return true;
  });
  const request: AgentRunRequest = {
    runId: "run",
    botId: "bot",
    threadId: "thread",
    prompt: "work",
    instructions: "",
    history: [],
    tools: "none",
    model: { provider: "test", id: "fake-model" },
    saveCheckpoint,
  };
  const events = (async () => {
    for await (const _event of new PiAgentRuntime().run(request)) {
    }
  })();
  await vi.waitFor(() => expect(saveCheckpoint).toHaveBeenCalledOnce());
  expect(fake.agents.at(-1)?.aborted).toBe(false);
  finish();
  await events;
  expect(fake.agents.at(-1)?.aborted).toBe(true);
  expect(saveCheckpoint.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({ role: "assistant" }),
  ]);
});
