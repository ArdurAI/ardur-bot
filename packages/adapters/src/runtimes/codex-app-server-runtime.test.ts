import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ardurbot/host-runtime/runtimes/ardur-mcp-server", () => ({
  startArdurMcpServer: async () => ({ config: { command: "node", args: [] }, close: vi.fn() }),
}));
vi.mock("@ardurbot/host-runtime/runtimes/native-process", async (original) => ({
  ...(await original<object>()),
  findNativeBinary: async () => "/fake/codex",
}));

import { CodexAppServerRuntime } from "./codex-app-server-runtime.js";

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};
function fixture(
  mode:
    | "success"
    | "login"
    | "reroute"
    | "approval"
    | "wrong-model"
    | "mcp-conflict"
    | "skills-error"
    | "usage" = "success",
) {
  const messages: Message[] = [];
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const send = (message: Message) => stdout.write(`${JSON.stringify(message)}\n`);
  const input = new Writable({
    write(chunk, _, done) {
      const message = JSON.parse(String(chunk)) as Message;
      messages.push(message);
      const result = (value: unknown) => send({ id: message.id, result: value });
      switch (message.method) {
        case "initialize":
          result({ userAgent: "test" });
          break;
        case "account/read":
          result({ account: mode === "login" ? null : { type: "chatgpt" } });
          break;
        case "model/list":
          result({
            data: [
              {
                model: "model",
                displayName: "Model",
                supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              },
            ],
            nextCursor: null,
          });
          break;
        case "config/read":
          result({
            config: {
              mcp_servers: {
                [mode === "mcp-conflict" ? "ardur" : "untrusted"]: { command: "must-not-run" },
              },
            },
          });
          break;
        case "skills/list":
          result({
            data: [
              {
                skills: [{ path: "/skills/private-context/SKILL.md" }],
                errors: mode === "skills-error" ? [{ message: "Unreadable skill" }] : [],
              },
            ],
          });
          break;
        case "thread/start":
        case "thread/resume":
          result({
            thread: { id: "thread-native" },
            model: mode === "wrong-model" ? "replacement" : "model",
            modelProvider: "openai",
            reasoningEffort: "high",
            sandbox: { type: "readOnly" },
          });
          break;
        case "turn/start":
          result({ turn: { id: "turn-native" } });
          queueMicrotask(() => {
            if (mode === "reroute")
              send({
                method: "model/rerouted",
                params: {
                  threadId: "thread-native",
                  fromModel: "model",
                  toModel: "replacement",
                  reason: "test",
                },
              });
            else if (mode === "approval")
              send({
                method: "item/commandExecution/requestApproval",
                id: "approval",
                params: {
                  threadId: "thread-native",
                  turnId: "turn-native",
                  command: "must-not-run",
                },
              });
            else {
              if (mode === "usage")
                for (const total of [
                  { inputTokens: 10, outputTokens: 5 },
                  { inputTokens: 10, outputTokens: 5 },
                  { inputTokens: 30, outputTokens: 8 },
                ])
                  send({
                    method: "thread/tokenUsage/updated",
                    params: {
                      threadId: "thread-native",
                      tokenUsage: { total, last: { inputTokens: 2, outputTokens: 1 } },
                    },
                  });
              send({
                method: "item/agentMessage/delta",
                params: { threadId: "thread-native", delta: "hello" },
              });
              send({
                method: "turn/completed",
                params: { threadId: "thread-native", turn: { status: "completed" } },
              });
            }
          });
          break;
        case "turn/interrupt":
          result({});
          break;
      }
      done();
    },
  });
  Object.assign(child, {
    stdout,
    stderr,
    stdin: input,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      Object.assign(child, { signalCode: "SIGTERM" });
      stdout.end();
      stderr.end();
      queueMicrotask(() => child.emit("close", 0));
      return true;
    }),
  });
  const spawn = vi.fn(() => child);
  const info = vi.fn();
  const request: AgentRunRequest = {
    botId: "bot",
    threadId: "ardur-thread",
    runId: "run",
    instructions: "bot instructions",
    history: [],
    prompt: "hello",
    tools: [],
    onRuntimeInfo: info,
    model: {
      provider: "openai-codex",
      id: "model",
      runtimePin: {
        runtimeKind: "codex-app-server",
        provider: "openai-codex",
        modelId: "model",
        effort: "high",
        credentialId: "native:codex-app-server",
        revision: 1,
      },
    },
  };
  const runtime = new CodexAppServerRuntime(spawn);
  const collect = async () => {
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(request)) events.push(event);
    return events;
  };
  return { collect, messages, request, info, spawn };
}
describe("Codex app-server protocol", () => {
  it("initializes ardur-bot, keeps the exact model and effort, records the session and disables other MCPs", async () => {
    const f = fixture();
    expect(await f.collect()).toEqual([{ type: "text", text: "hello" }, { type: "done" }]);
    expect(f.messages[0]).toMatchObject({
      method: "initialize",
      params: { clientInfo: { name: "ardur-bot" } },
    });
    expect(f.messages[1]).toEqual({ method: "initialized" });
    expect(f.messages.find((event) => event.method === "thread/start")).toMatchObject({
      params: { model: "model", config: { mcp_servers: { untrusted: { enabled: false } } } },
    });
    expect(f.messages.find((event) => event.method === "turn/start")).toMatchObject({
      params: { model: "model", effort: "high" },
    });
    expect(f.info).toHaveBeenCalledWith({
      runtimeKind: "codex-app-server",
      sessionId: "thread-native",
    });
  });
  it("fails without starting a thread when ChatGPT login is missing", async () => {
    const f = fixture("login");
    await expect(f.collect()).rejects.toMatchObject({
      problem: { code: "runtime-unavailable", pin: f.request.model.runtimePin },
    });
    expect(f.messages.some((event) => event.method === "thread/start")).toBe(false);
  });
  it("refuses a conflicting MCP definition instead of inheriting its launch settings", async () => {
    const f = fixture("mcp-conflict");
    await expect(f.collect()).rejects.toMatchObject({ problem: { code: "runtime-unavailable" } });
    expect(f.messages.some((event) => event.method === "thread/start")).toBe(false);
  });
  it.each(["reroute", "wrong-model"] as const)(
    "fails closed for %s without rewriting the pin",
    async (mode) => {
      const f = fixture(mode);
      const pin = structuredClone(f.request.model.runtimePin);
      await expect(f.collect()).rejects.toMatchObject({
        problem: { code: "pin-model-unknown", pin },
      });
      expect(f.request.model.runtimePin).toEqual(pin);
    },
  );
  it("declines built-in effects and yields an Ardur ask card", async () => {
    const f = fixture("approval");
    expect(await f.collect()).toEqual([expect.objectContaining({ type: "ask" })]);
    expect(f.messages).toContainEqual({ id: "approval", result: { decision: "decline" } });
    expect(f.messages.some((event) => event.method === "turn/interrupt")).toBe(true);
  });
});

it("disables document discovery and memory injection for a controlled comparison", async () => {
  const f = fixture();
  f.request.controlledComparison = true;
  await f.collect();
  expect(f.messages.find((message) => message.method === "thread/start")).toMatchObject({
    params: {
      config: {
        project_doc_max_bytes: 0,
        developer_instructions: "",
        personality: "none",
        skills: { config: [{ path: "/skills/private-context/SKILL.md", enabled: false }] },
        memories: { use_memories: false, generate_memories: false },
      },
    },
  });
});
it("does not start a comparison when the native skill inventory cannot be isolated", async () => {
  const f = fixture("skills-error");
  f.request.controlledComparison = true;
  await expect(f.collect()).rejects.toMatchObject({
    problem: {
      code: "runtime-unavailable",
      reason: "Codex could not isolate saved skills — retry or change the pin.",
    },
  });
  expect(f.messages.some((message) => message.method === "thread/start")).toBe(false);
  expect(f.messages.some((message) => message.method === "turn/start")).toBe(false);
});
it("counts cumulative comparison usage once across repeated notifications and model calls", async () => {
  const f = fixture("usage");
  f.request.controlledComparison = true;
  expect((await f.collect()).filter((event) => event.type === "usage")).toEqual([
    { type: "usage", provider: "openai-codex", model: "model", inputTokens: 10, outputTokens: 5 },
    { type: "usage", provider: "openai-codex", model: "model", inputTokens: 20, outputTokens: 3 },
  ]);
});
