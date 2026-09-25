import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ binary: vi.fn(), version: vi.fn() }));
beforeEach(() => {
  native.binary.mockResolvedValue("/fake/codex");
  native.version.mockResolvedValue({ code: 0, version: "0.156.1" });
});
afterEach(() => vi.clearAllMocks());

vi.mock("@ardurbot/host-runtime/runtimes/ardur-mcp-server", () => ({
  startArdurMcpServer: async () => ({ config: { command: "node", args: [] }, close: vi.fn() }),
}));
vi.mock("@ardurbot/host-runtime/runtimes/native-process", async (original) => ({
  ...(await original<object>()),
  findNativeBinary: native.binary,
  probeCommand: native.version,
}));

import { resolveRunModelPin } from "../run-model-pin.js";
import { CodexAppServerRuntime, probeCodex } from "./codex-app-server-runtime.js";

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number };
};
function fixture(
  mode:
    | "unsupported"
    | "unreachable"
    | "success"
    | "login"
    | "reroute"
    | "approval"
    | "wrong-model"
    | "mcp-conflict"
    | "skills-error"
    | "usage" = "success",
  scenario?: { beforeStart?: Message[]; duringTurn: Message[] },
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
          if (mode === "unsupported" || mode === "unreachable")
            send({ id: message.id, error: { code: mode === "unsupported" ? -32601 : -32000 } });
          else result({ userAgent: "test" });
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
          for (const event of scenario?.beforeStart ?? []) send(event);
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
            else if (scenario) {
              for (const event of scenario.duringTurn) send(event);
            } else {
              if (mode === "usage")
                for (const total of [
                  { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 },
                  { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 },
                  { inputTokens: 30, outputTokens: 8, cachedInputTokens: 14 },
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
        case "thread/read":
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
  const usage = (inputTokens: number, outputTokens: number, turnId = "turn-native"): Message => ({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-native",
      turnId,
      tokenUsage: {
        total: {
          inputTokens,
          outputTokens,
          cachedInputTokens: inputTokens / 2,
          cacheWriteInputTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
    },
  });
  const completed: Message = {
    method: "turn/completed",
    params: { threadId: "thread-native", turn: { id: "turn-native", status: "completed" } },
  };
  it("accounts ordinary final usage after completion and ignores unrelated turns and duplicate completion", async () => {
    const f = fixture("success", {
      duringTurn: [
        usage(10, 5),
        usage(900, 200, "other-turn"),
        completed,
        completed,
        usage(30, 8),
        usage(30, 8),
      ],
    });
    const events = await f.collect();
    const receipts = events.filter((event) => event.type === "usage");
    expect(receipts.at(-1)).toMatchObject({
      inputTokens: 30,
      outputTokens: 8,
      request: { collection: { outcome: "success" } },
    });
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(f.messages.filter((message) => message.method === "thread/read")).toHaveLength(1);
    expect(f.request.controlledComparison).toBeUndefined();
  });
  it("seeds a resumed invocation only from usage observed before its new turn", async () => {
    const f = fixture("success", {
      beforeStart: [usage(100, 20, "previous-turn")],
      duringTurn: [usage(110, 25), usage(130, 28), completed],
    });
    f.request.nativeSession = { runtimeKind: "codex-app-server", sessionId: "thread-native" };
    const receipts = (await f.collect()).filter((event) => event.type === "usage");
    expect(receipts.at(-1)).toMatchObject({
      inputTokens: 30,
      outputTokens: 8,
      request: {
        categories: { logicalInput: 30, cacheReadInput: 15 },
        collection: { raw: { input: 130, output: 28 } },
      },
    });
  });
  it("exposes an unavailable resumed boundary without charging the thread lifetime", async () => {
    const f = fixture("success", { duringTurn: [usage(110, 25), usage(130, 28), completed] });
    f.request.nativeSession = { runtimeKind: "codex-app-server", sessionId: "thread-native" };
    const receipts = (await f.collect()).filter((event) => event.type === "usage");
    expect(receipts.at(-1)?.request).toMatchObject({
      categories: { logicalInput: null, output: null },
      collection: {
        outcome: "success",
        availability: "unavailable",
        limitations: expect.arrayContaining(["unverified-resume-boundary"]),
      },
    });
  });
  it("initializes ardur-bot, keeps the exact model and effort, records the session and disables other MCPs", async () => {
    const f = fixture();
    const events = await f.collect();
    expect(events.filter((event) => event.type !== "usage")).toEqual([
      { type: "text", text: "hello" },
      { type: "done" },
    ]);
    expect(events.filter((event) => event.type === "usage").at(-1)).toMatchObject({
      request: { collection: { outcome: "success", availability: "unavailable" } },
    });
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
    expect((await f.collect()).filter((event) => event.type !== "usage")).toEqual([
      expect.objectContaining({ type: "ask" }),
    ]);
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
it.each([false, true])(
  "counts cumulative fresh-session usage once (comparison=%s)",
  async (comparison) => {
    const f = fixture("usage");
    f.request.controlledComparison = comparison;
    const events = (await f.collect()).filter((event) => event.type === "usage");
    expect(events).toHaveLength(4); // start, two distinct snapshots, terminal receipt
    expect(events.at(-1)).toMatchObject({
      provider: "openai-codex",
      model: "model",
      inputTokens: 30,
      outputTokens: 8,
      cachedTokens: 14,
      request: {
        counter: { mode: "cumulative" },
        categories: {
          logicalInput: 30,
          output: 8,
          cacheReadInput: 14,
          cacheWriteInput: null,
          reasoning: null,
        },
        collection: { outcome: "success", scope: "native-turn" },
      },
    });
    expect(new Set(events.map((event) => event.request?.attemptId)).size).toBe(1);
  },
);

describe("Codex availability", () => {
  it("accepts 0.156.1 through the protocol and reports sign-in and models", async () => {
    const f = fixture();
    await expect(probeCodex(f.spawn)).resolves.toEqual({
      runtimeKind: "codex-app-server",
      version: "0.156.1",
      signedIn: true,
      available: true,
      models: [{ id: "model", label: "Model", efforts: ["high"] }],
    });
  });
  it("reports a missing binary without attempting sign-in", async () => {
    native.binary.mockResolvedValue(null);
    const f = fixture();
    await expect(probeCodex(f.spawn)).resolves.toMatchObject({
      available: false,
      reason: "Codex is not installed.",
    });
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each([
    ["login", "Not signed in — run codex login."],
    ["unsupported", "Codex version 0.156.1 is not supported yet."],
    ["unreachable", "Codex could not be reached. Check again or restart the desktop app."],
  ] as const)("distinguishes %s from missing installation", async (mode, reason) => {
    const f = fixture(mode);
    const result = await probeCodex(f.spawn);
    expect(result).toMatchObject({ available: false, version: "0.156.1", reason, models: [] });
    if (mode === "login") expect(result.signedIn).toBe(false);
  });
  it("refuses an explicitly bound hosted connection even before its secret is loaded", async () => {
    const f = fixture();
    f.request.model.runtimePin!.credentialId = "hosted-connection";
    await expect(f.collect()).rejects.toMatchObject({ problem: { code: "runtime-unavailable" } });
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("still refuses explicitly supplied key or OAuth material before spawning", async () => {
    for (const auth of [
      { apiKey: "test-key" },
      {
        oauth: {
          credential: {
            type: "oauth" as const,
            access: "test-access",
            refresh: "test-refresh",
            expires: 0,
          },
        },
      },
    ]) {
      const f = fixture();
      Object.assign(f.request.model, auth);
      await expect(f.collect()).rejects.toMatchObject({
        problem: {
          code: "runtime-unavailable",
          reason:
            "Codex uses its own ChatGPT sign-in. Remove the pinned connection or change the runtime.",
        },
      });
      expect(f.spawn).not.toHaveBeenCalled();
    }
  });
});

it("runs a native pin while the space has an inherited hosted credential", async () => {
  const f = fixture();
  const hosted = vi.fn(async () => ({
    id: "hosted-connection",
    provider: "openai-codex",
    secretId: "hosted-secret",
  }));
  const loadKey = vi.fn();
  const selected = await resolveRunModelPin({
    prisma: {
      userModelCredential: { findFirst: hosted },
      spaceModelPreference: { findFirst: hosted },
    } as never,
    scope: { userId: "owner", spaceId: "space" },
    bot: {
      runtimeKind: "codex-app-server",
      modelProvider: "openai-codex",
      modelId: "model",
      thinkingLevel: "high",
      modelCredentialId: "native:codex-app-server",
      modelPinRevision: 1,
    },
    scripted: false,
    loadKey,
  });
  if (selected.kind !== "resolved") throw new Error(selected.reason);
  f.request.model = selected;
  expect((await f.collect()).filter((event) => event.type !== "usage")).toEqual([
    { type: "text", text: "hello" },
    { type: "done" },
  ]);
  expect(hosted).not.toHaveBeenCalled();
  expect(loadKey).not.toHaveBeenCalled();
});
