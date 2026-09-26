import type { AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { expect, it, vi } from "vitest";

type FakeAgentTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

// The parent runs one helper; the helper runs one shell call.
vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: FakeAgentTool[];
    constructor(options: { initialState: { tools: FakeAgentTool[] } }) {
      this.tools = options.initialState.tools;
    }
    subscribe(_listener: unknown) {}
    async prompt() {
      const helper = this.tools.find((tool) => tool.name === "run_subagent");
      if (helper) {
        await helper.execute("parent-call", { name: "Builder", task: "Build it" });
        return;
      }
      await this.tools
        .find((tool) => tool.name === "shell")
        ?.execute("helper-call", { command: "make build" });
    }
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) => ({
      provider: "test",
      id: modelId,
      reasoning: false,
    }),
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
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

import { PiAgentRuntime } from "./pi-runtime.js";

it("names the helper delegation on a helper's tool event", async () => {
  const executeHelperTool = vi.fn(async () => ({ ok: true }));
  const executeTool = vi.fn(async () => ({ ok: true }));
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(
    {
      botId: "b",
      threadId: "t",
      runId: "r",
      prompt: "build it",
      instructions: "",
      history: [],
      tools: [
        {
          name: "run_subagent",
          description: "Run a helper",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" }, task: { type: "string" } },
          },
        },
        {
          name: "shell",
          description: "Run a command",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      model: { provider: "test", id: "helper-model" },
      admitHelper: async () => ({
        id: "delegation-1",
        tokens: 10_000,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      executeTool,
      executeHelperTool,
    },
    { signal: new AbortController().signal },
  ))
    events.push(event);
  const tools = events.filter((event) => event.type === "tool");
  expect(tools).toContainEqual({
    type: "tool",
    name: "shell",
    args: { command: "make build" },
    executionId: "helper-call",
    delegationId: "delegation-1",
  });
  expect(tools.find((event) => event.executionId === "parent-call")).not.toHaveProperty(
    "delegationId",
  );
  expect(executeHelperTool).toHaveBeenCalledWith(
    "delegation-1",
    "shell",
    { command: "make build" },
    "helper-call",
    undefined,
  );
  expect(executeTool).not.toHaveBeenCalled();
});
