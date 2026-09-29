import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
    | "profile-conflict"
    | "user-default-permissions"
    | "profile-missing"
    | "profile-network"
    | "turn-rejected"
    | "thread-rejected"
    | "skills-error"
    | "mcp-approval"
    | "mcp-approval-other"
    | "mcp-form"
    | "unknown-request"
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
              ...(mode === "profile-conflict"
                ? { permissions: { "ardur-read": { filesystem: { "/": "write" } } } }
                : {}),
              ...(mode === "user-default-permissions"
                ? { default_permissions: "user-profile" }
                : {}),
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
          if (mode === "thread-rejected") {
            send({ id: message.id, error: { code: -32603 } });
            break;
          }
          for (const event of scenario?.beforeStart ?? []) send(event);
          result({
            thread: { id: "thread-native" },
            model: mode === "wrong-model" ? "replacement" : "model",
            modelProvider: "openai",
            reasoningEffort: "high",
            sandbox: { type: "readOnly", networkAccess: mode === "profile-network" },
            ...(mode === "profile-missing"
              ? {}
              : { activePermissionProfile: { id: "ardur-read", extends: null } }),
          });
          break;
        case "turn/start":
          if (mode === "turn-rejected") {
            send({ id: message.id, error: { code: -32600 } });
            break;
          }
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
            else if (
              mode === "mcp-approval" ||
              mode === "mcp-approval-other" ||
              mode === "mcp-form"
            ) {
              send({
                method: "mcpServer/elicitation/request",
                id: "elicit",
                params: {
                  serverName: mode === "mcp-approval-other" ? "other-server" : "ardur",
                  threadId: "thread-native",
                  turnId: "turn-native",
                  message: "Approve tool call?",
                  mode: "form",
                  requestedSchema: { type: "object", properties: {} },
                  ...(mode === "mcp-form"
                    ? {}
                    : { _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "handoff" } }),
                },
              });
              if (mode === "mcp-approval") {
                send({
                  method: "item/agentMessage/delta",
                  params: { threadId: "thread-native", delta: "hello" },
                });
                send({
                  method: "turn/completed",
                  params: { threadId: "thread-native", turn: { status: "completed" } },
                });
              }
            } else if (mode === "unknown-request") {
              send({
                id: "auth-refresh",
                method: "account/chatgptAuthTokens/refresh",
                params: { reason: "unauthorized" },
              });
              send({
                method: "item/agentMessage/delta",
                params: { threadId: "thread-native", delta: "hello" },
              });
              send({
                method: "turn/completed",
                params: { threadId: "thread-native", turn: { status: "completed" } },
              });
            } else if (scenario) {
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
  return { collect, messages, request, info, spawn, runtime, child };
}
describe("Codex app-server protocol", () => {
  it("stops a held turn after cancellation", async () => {
    const f = fixture("success", {
      duringTurn: [
        {
          method: "item/agentMessage/delta",
          params: { threadId: "thread-native", delta: "hello" },
        },
      ],
    });
    const controller = new AbortController();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of f.runtime.run(f.request, { signal: controller.signal })) {
      events.push(event);
      if (event.type === "text") {
        controller.abort();
        await f.runtime.abort(f.request.runId);
      }
    }
    expect(f.child.kill).toHaveBeenCalled();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
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
  it("names the limitation and keeps totals null when a turn is interrupted before usage", async () => {
    const f = fixture("success", {
      duringTurn: [
        {
          method: "item/agentMessage/delta",
          params: { threadId: "thread-native", delta: "hello" },
        },
      ],
    });
    const controller = new AbortController();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of f.runtime.run(f.request, { signal: controller.signal })) {
      events.push(event);
      if (event.type === "text") {
        controller.abort();
        await f.runtime.abort(f.request.runId);
      }
    }
    const final = events.filter((event) => event.type === "usage").at(-1);
    expect(final?.request?.categories).toEqual({
      logicalInput: null,
      uncachedInput: null,
      cacheReadInput: null,
      cacheWriteInput: null,
      output: null,
      reasoning: null,
    });
    expect(final?.request?.collection).toMatchObject({
      outcome: "cancelled",
      availability: "unavailable",
      limitations: expect.arrayContaining(["late-usage-unverified"]),
    });
  });
  it("keeps partial measured spend with a named limitation when interrupted mid-turn", async () => {
    const f = fixture("success", {
      duringTurn: [
        usage(30, 8),
        {
          method: "item/agentMessage/delta",
          params: { threadId: "thread-native", delta: "hello" },
        },
      ],
    });
    const controller = new AbortController();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of f.runtime.run(f.request, { signal: controller.signal })) {
      events.push(event);
      if (event.type === "text") {
        controller.abort();
        await f.runtime.abort(f.request.runId);
      }
    }
    const final = events.filter((event) => event.type === "usage").at(-1);
    expect(final?.request?.categories).toMatchObject({ logicalInput: 30, output: 8 });
    expect(final?.request?.collection).toMatchObject({
      outcome: "cancelled",
      limitations: expect.arrayContaining(["late-usage-unverified"]),
    });
  });
  it("records a failed completed turn with its outcome and measured totals", async () => {
    const f = fixture("success", {
      duringTurn: [
        usage(30, 8),
        {
          method: "turn/completed",
          params: { threadId: "thread-native", turn: { id: "turn-native", status: "failed" } },
        },
      ],
    });
    const events: AgentRuntimeEvent[] = [];
    await expect(
      (async () => {
        for await (const event of f.runtime.run(f.request)) events.push(event);
      })(),
    ).rejects.toMatchObject({ problem: { code: "runtime-unavailable" } });
    const final = events.filter((event) => event.type === "usage").at(-1);
    expect(final?.request?.categories).toMatchObject({ logicalInput: 30, output: 8 });
    expect(final?.request?.collection?.outcome).toBe("failed");
  });
  it.each([
    [
      { message: "You hit your usage limit. Try again later." },
      "usage-limit",
      "usage limit is reached",
    ],
    [{ message: "Unauthorized: not logged in" }, "signed-out", "Sign in to Codex"],
  ] as const)(
    "names the real cause of a failed turn without echoing its text: %j",
    async (turnError, reasonId, sentence) => {
      const f = fixture("success", {
        duringTurn: [
          {
            method: "turn/completed",
            params: {
              threadId: "thread-native",
              turn: { id: "turn-native", status: "failed", error: turnError },
            },
          },
        ],
      });
      let failure: unknown;
      await (async () => {
        for await (const _ of f.runtime.run(f.request)) void _;
      })().catch((error) => {
        failure = error;
      });
      expect(failure).toMatchObject({ problem: { code: "runtime-unavailable", reasonId } });
      expect((failure as Error).message).toContain(sentence);
      expect((failure as Error).message).not.toContain((turnError as { message: string }).message);
    },
  );
  it("names the limitation when a reroute interrupts the turn", async () => {
    const f = fixture("reroute");
    const events: AgentRuntimeEvent[] = [];
    await expect(
      (async () => {
        for await (const event of f.runtime.run(f.request)) events.push(event);
      })(),
    ).rejects.toMatchObject({ problem: { code: "pin-model-unknown" } });
    const final = events.filter((event) => event.type === "usage").at(-1);
    expect(final?.request?.collection).toMatchObject({
      outcome: "cancelled",
      limitations: expect.arrayContaining(["late-usage-unverified"]),
    });
  });
  it("initializes ardur-bot, keeps the exact model and effort, records the session and disables other MCPs", async () => {
    const f = fixture();
    f.request.nativeCwd = "/safe-workspace";
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
      params: { clientInfo: { name: "ardur-bot" }, capabilities: { experimentalApi: true } },
    });
    expect(f.messages[1]).toEqual({ method: "initialized" });
    const args = f.spawn.mock.calls[0] as unknown as [string, string[], string?];
    expect(args[1]).toContain("features.view_image=false");
    expect(args[1]).not.toContain("tools.view_image=false");
    const threadStart = f.messages.find((event) => event.method === "thread/start");
    expect(threadStart).toMatchObject({
      params: {
        model: "model",
        config: {
          mcp_servers: { untrusted: { enabled: false } },
          default_permissions: "ardur-read",
          permissions: {
            "ardur-read": {
              filesystem: { ":minimal": "read", "/safe-workspace": "read" },
              network: { enabled: false },
            },
          },
          features: { view_image: false },
        },
      },
    });
    expect(threadStart?.params).not.toHaveProperty("sandbox");
    const turnStart = f.messages.find((event) => event.method === "turn/start");
    expect(turnStart).toMatchObject({
      params: { model: "model", effort: "high" },
    });
    expect(turnStart?.params).not.toHaveProperty("sandboxPolicy");
    expect(f.info).toHaveBeenCalledWith({
      runtimeKind: "codex-app-server",
      sessionId: "thread-native",
    });
  });
  it("uses only the minimal readable roots without a native working directory", async () => {
    const f = fixture();
    await f.collect();
    const config = f.messages.find((event) => event.method === "thread/start")?.params?.config as
      | { permissions: { "ardur-read": { filesystem: Record<string, string> } } }
      | undefined;
    expect(config?.permissions?.["ardur-read"]?.filesystem).toEqual({ ":minimal": "read" });
  });
  it("applies the same profile when resuming a thread", async () => {
    const f = fixture();
    f.request.nativeSession = { runtimeKind: "codex-app-server", sessionId: "thread-native" };
    await f.collect();
    expect(f.messages.find((event) => event.method === "thread/resume")).toMatchObject({
      params: { threadId: "thread-native", config: { default_permissions: "ardur-read" } },
    });
    expect(f.messages.find((event) => event.method === "thread/resume")?.params).not.toHaveProperty(
      "sandbox",
    );
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
  it("refuses a user profile that would merge into the run's read profile", async () => {
    const f = fixture("profile-conflict");
    await expect(f.collect()).rejects.toMatchObject({
      problem: {
        code: "runtime-unavailable",
        reason:
          "Codex already has an ardur-read permission profile configured — remove it or change the pin.",
      },
    });
    expect(f.messages.some((event) => event.method === "thread/start")).toBe(false);
  });
  it("overrides a user default permission profile with the run's read profile", async () => {
    const f = fixture("user-default-permissions");
    await f.collect();
    expect(f.messages.find((event) => event.method === "thread/start")).toMatchObject({
      params: { config: { default_permissions: "ardur-read" } },
    });
  });
  it.each(["profile-missing", "profile-network"] as const)(
    "fails closed when the thread reports %s",
    async (mode) => {
      const f = fixture(mode);
      await expect(f.collect()).rejects.toMatchObject({
        problem: {
          code: "runtime-unavailable",
          reason: "Codex cannot enforce the requested sandbox — change the pin.",
        },
      });
      expect(f.messages.some((event) => event.method === "turn/start")).toBe(false);
    },
  );
  it("reports a rejected turn as a runtime protocol error", async () => {
    const f = fixture("turn-rejected");
    await expect(f.collect()).rejects.toMatchObject({
      problem: {
        code: "runtime-unavailable",
        reason: "Codex rejected the request — update Ardur or Codex.",
      },
    });
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
  it("pre-approves only the ardur MCP server in the thread config", async () => {
    const f = fixture();
    await f.collect();
    expect(f.messages.find((event) => event.method === "thread/start")).toMatchObject({
      params: {
        config: {
          mcp_servers: {
            untrusted: { enabled: false },
            ardur: {
              command: "node",
              enabled: true,
              required: true,
              default_tools_approval_mode: "approve",
            },
          },
        },
      },
    });
  });
  it("accepts an ardur MCP tool-call approval without a decline or a card", async () => {
    const f = fixture("mcp-approval");
    const events = await f.collect();
    expect(events.filter((event) => event.type !== "usage")).toEqual([
      { type: "text", text: "hello" },
      { type: "done" },
    ]);
    expect(f.messages).toContainEqual({ id: "elicit", result: { action: "accept" } });
    expect(f.messages.some((event) => JSON.stringify(event).includes("decline"))).toBe(false);
    expect(events.some((event) => event.type === "ask")).toBe(false);
  });
  it("declines a tool-call approval from any other MCP server, with the card", async () => {
    const f = fixture("mcp-approval-other");
    expect((await f.collect()).filter((event) => event.type !== "usage")).toEqual([
      {
        type: "ask",
        text: "Codex requested input for another MCP server — continue using Ardur tools.",
        actions: [{ id: "continue", label: "Continue" }],
      },
    ]);
    expect(f.messages).toContainEqual({ id: "elicit", result: { action: "decline" } });
    expect(f.messages.some((event) => event.method === "turn/interrupt")).toBe(true);
  });
  it("declines an ardur elicitation that is not a marked tool-call approval", async () => {
    const f = fixture("mcp-form");
    expect((await f.collect()).filter((event) => event.type !== "usage")).toEqual([
      {
        type: "ask",
        text: "Codex asked Ardur to collect form input — Ardur doesn't take forms, so it was declined.",
        actions: [{ id: "continue", label: "Continue" }],
      },
    ]);
    expect(f.messages).toContainEqual({ id: "elicit", result: { action: "decline" } });
    expect(f.messages.some((event) => event.method === "turn/interrupt")).toBe(true);
  });
  it("answers unknown server requests with -32601 and continues the turn", async () => {
    const f = fixture("unknown-request");
    const events = await f.collect();
    expect(events.filter((event) => event.type !== "usage")).toEqual([
      { type: "text", text: "hello" },
      { type: "done" },
    ]);
    expect(f.messages).toContainEqual({
      id: "auth-refresh",
      error: { code: -32601, message: "This request is not supported by Ardur." },
    });
    expect(events.some((event) => event.type === "ask")).toBe(false);
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
      space: { findUnique: vi.fn(async () => ({ allowedModelDestinations: null })) },
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

describe("instruction file grants", () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  it.each(["thread/start", "thread/resume"] as const)(
    "grants exactly the ancestor instruction files for %s",
    async (method) => {
      root = await mkdtemp(path.join(tmpdir(), "codex-grants-"));
      const repo = path.join(root, "repo");
      const folder = path.join(repo, "a", "b");
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(folder, { recursive: true });
      const f = fixture();
      f.request.nativeCwd = folder;
      if (method === "thread/resume")
        f.request.nativeSession = { runtimeKind: "codex-app-server", sessionId: "thread-native" };
      await f.collect();
      const start = f.messages.find((event) => event.method === method);
      const config = start?.params?.config as {
        permissions?: { "ardur-read": { filesystem: Record<string, string> } };
      };
      const files = [repo, path.join(repo, "a"), folder].flatMap((dir) => [
        path.join(dir, "AGENTS.md"),
        path.join(dir, "AGENTS.override.md"),
      ]);
      expect(config.permissions?.["ardur-read"].filesystem).toEqual({
        ":minimal": "read",
        [folder]: "read",
        ...Object.fromEntries(files.map((file) => [file, "read"])),
      });
    },
  );
  it("reports a rejected session start as such and sends no turn", async () => {
    const f = fixture("thread-rejected");
    await expect(f.collect()).rejects.toMatchObject({
      problem: {
        code: "runtime-unavailable",
        reason:
          "Codex could not start a session in this bot's folder \u2014 change the bot's computer or the pin.",
      },
    });
    expect(f.messages.some((event) => event.method === "turn/start")).toBe(false);
  });
});
