import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import type { RuntimePin } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { assertClaudeTools, ClaudeStreamParser, claudeArguments } from "./claude-code-runtime.js";
import { nativeEnvironment } from "./native-process.js";

const pin: RuntimePin = {
  runtimeKind: "claude-code",
  provider: "anthropic",
  modelId: "claude-opus-5",
  effort: "low",
  credentialId: "native:claude-code",
  revision: 1,
};
const request: AgentRunRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "Hello",
  instructions: "Instructions and memory",
  history: [],
  tools: [],
  model: { provider: "anthropic", id: pin.modelId!, runtimePin: pin },
};
const init = {
  type: "system",
  subtype: "init",
  model: pin.modelId,
  session_id: "session",
  tools: ["mcp__ardur__read_file"],
};
describe("Claude stream-json boundary", () => {
  it("parses text once, skips tool observations, and ends only on success", () => {
    const parser = new ClaudeStreamParser(pin);
    expect(parser.parse(init)).toEqual([]);
    expect(
      parser.parse({
        type: "stream_event",
        event: { type: "message_start", message: { model: pin.modelId } },
      }),
    ).toEqual([]);
    expect(
      parser.parse({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
      }),
    ).toEqual([{ type: "text", text: "hello" }]);
    expect(
      parser.parse({
        type: "assistant",
        message: {
          model: pin.modelId,
          content: [{ type: "tool_use", id: "call", name: "mcp__ardur__read_file", input: {} }],
        },
      }),
    ).toEqual([]);
    expect(
      parser.parse({
        type: "result",
        subtype: "success",
        is_error: false,
        modelUsage: { [pin.modelId!]: {} },
      }),
    ).toEqual([{ type: "done" }]);
    expect(parser.sessionId).toBe("session");
  });
  it("rejects builtin tools before allowing any MCP effect", () => {
    expect(() => assertClaudeTools(["Bash", "mcp__ardur__read_file"], pin)).toThrow();
    expect(() => new ClaudeStreamParser(pin).parse({ ...init, tools: ["Read"] })).toThrow();
  });
  it("fails on rerouting, missing attestation and errors without exposing vendor output", () => {
    const parser = new ClaudeStreamParser(pin);
    parser.parse(init);
    expect(() => parser.parse({ type: "assistant", message: { model: "other" } })).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ code: "pin-model-unknown", pin }),
      }),
    );
    expect(parser.initialized).toBe(false);
    expect(() => parser.parse({ type: "result", subtype: "success" })).toThrow();
    expect(() =>
      parser.parse({ type: "result", is_error: true, errors: ["private-output"] }),
    ).toThrow("Claude Code could not finish");
  });
  it("uses documented tool isolation and a scoped resume id without passing credentials", () => {
    const args = claudeArguments(request, { command: "node", args: [] }, "session");
    expect(args).toContain("--restricted");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args[args.indexOf("--model") + 1]).toBe(pin.modelId);
    expect(args[args.indexOf("--effort") + 1]).toBe(pin.effort);
    expect(
      claudeArguments(
        { ...request, nativeSession: { runtimeKind: "claude-code", sessionId: "thread-session" } },
        {},
        "thread-session",
      ),
    ).toContain("--resume");
    expect(() =>
      claudeArguments({ ...request, model: { ...request.model, apiKey: "fake-secret" } }, {}, "s"),
    ).toThrow();
    expect(() =>
      claudeArguments(
        {
          ...request,
          model: {
            ...request.model,
            oauth: {
              credential: {
                type: "oauth",
                access: "fake-access",
                refresh: "fake-refresh",
                expires: 0,
              },
            },
          },
        },
        {},
        "s",
      ),
    ).toThrow();
    expect(args.join(" ")).not.toMatch(/fake-secret|fake-access|fake-refresh|API_KEY|OAUTH_TOKEN/);
    expect(
      nativeEnvironment({
        HOME: "/home/test",
        PATH: "/bin",
        ANTHROPIC_API_KEY: "fake-secret",
        OPENAI_API_KEY: "fake-secret",
        CLAUDE_CODE_OAUTH_TOKEN: "fake-secret",
        NODE_OPTIONS: "--require bad",
        BOT_SECRET: "fake-secret",
      }),
    ).toEqual({ HOME: "/home/test", PATH: "/bin" });
  });
});

it("keeps the host compatibility catalog aligned with the pinned built-in catalog", async () => {
  const { listPiCatalog } = await import("../pi-models.js");
  const { claudeModels } = await import("./claude-code-runtime.js");
  const expected = listPiCatalog()
    .filter(
      (model) =>
        model.provider === "anthropic" &&
        /^(claude-(?:opus-(?:5(?:-5)?|4-[678])|sonnet-(?:5|4-6)|fable-5(?:-1)?))(?:-\d{8})?$/.test(
          model.id,
        ) &&
        model.thinkingLevels?.includes("low") &&
        !model.placeholder,
    )
    .map((model) => ({ id: model.id, label: model.label, efforts: ["low"] }));
  expect(claudeModels()).toEqual(expected);
});

it("keeps comparison sessions free of discovered instructions and mutable memory", () => {
  const args = claudeArguments({ ...request, controlledComparison: true }, {}, "session");
  expect(args).toContain("--safe-mode");
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toMatchObject({
    autoMemoryEnabled: false,
    disableAllHooks: true,
  });
  expect(args).not.toContain("--resume");
});
it("retains reported token usage without inventing cost", () => {
  const parser = new ClaudeStreamParser(pin);
  parser.parse(init);
  expect(
    parser.parse({
      type: "result",
      subtype: "success",
      modelUsage: { [pin.modelId!]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 } },
    }),
  ).toEqual([
    { type: "usage", provider: "anthropic", model: pin.modelId, inputTokens: 12, outputTokens: 5 },
    { type: "done" },
  ]);
});
