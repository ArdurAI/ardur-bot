import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { renameSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  startArdurMcpServer: async () => ({
    config: {
      command: "node",
      args: ["bridge", "a1".repeat(32)],
      env: { BRIDGE_TOKEN: "b2".repeat(32) },
    },
    close: vi.fn(),
  }),
}));
vi.mock("@ardurbot/host-runtime/runtimes/native-process", async (original) => ({
  ...(await original<object>()),
  findNativeBinary: native.binary,
  probeCommand: native.version,
}));

import { resolveRunModelPin } from "../run-model-pin.js";
import {
  CodexAppServerRuntime,
  INSTRUCTION_CHANGE_SLACK_MS,
  probeCodex,
} from "./codex-app-server-runtime.js";

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
  /**
   * What this Codex answers when a session starts, and anything that happens to the disk
   * along the way. It reports the instruction files it loaded (none, unless set) and the
   * folder it was asked to use.
   */
  const loaded: {
    instructionSources?: unknown;
    omitInstructionSources?: boolean;
    cwd?: unknown;
    whileConfiguring?: () => void;
    whileStarting?: () => void;
  } = {};
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
          loaded.whileConfiguring?.();
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
          loaded.whileStarting?.();
          result({
            ...(loaded.omitInstructionSources
              ? {}
              : { instructionSources: loaded.instructionSources ?? [] }),
            cwd: "cwd" in loaded ? loaded.cwd : message.params?.cwd,
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
  return { collect, messages, request, info, spawn, runtime, child, loaded };
}
describe("Codex app-server protocol", () => {
  it("saves model context and usage before interrupting for restart", async () => {
    const f = fixture("success", {
      duringTurn: [
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-native",
            tokenUsage: { total: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 } },
          },
        },
        {
          method: "item/completed",
          params: {
            threadId: "thread-native",
            turnId: "turn-native",
            item: { type: "agentMessage", text: "Saved response" },
          },
        },
      ],
    });
    let release!: () => void;
    const stored = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.saveCheckpoint = vi.fn(async () => {
      await stored;
      return true;
    });
    const work = f.collect();
    await vi.waitFor(() => expect(f.request.saveCheckpoint).toHaveBeenCalledOnce());
    expect(f.messages.some((message) => message.method === "turn/interrupt")).toBe(false);
    expect(f.request.saveCheckpoint).toHaveBeenCalledWith(
      [expect.objectContaining({ text: "Saved response" })],
      [expect.objectContaining({ inputTokens: 10, outputTokens: 5 })],
    );
    release();
    await work;
    expect(f.messages.some((message) => message.method === "turn/interrupt")).toBe(true);
  });
  it("redacts bridge credentials registered after the app-server starts", async () => {
    vi.stubEnv("ARDUR_DETAILED_PROCESS_LOGS", "1");
    vi.stubEnv("LOG_LEVEL", "debug");
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const f = fixture();
      f.loaded.whileStarting = () => {
        (f.child.stderr as PassThrough).write(`${"a1".repeat(32)}\n${"b2".repeat(32)}\n`);
      };
      await f.collect();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const logs = write.mock.calls.map(([line]) => String(line)).join("");
      expect(logs).toContain("codex-app-server stderr: [redacted]");
      expect(logs).not.toContain("a1".repeat(32));
      expect(logs).not.toContain("b2".repeat(32));
    } finally {
      write.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("keeps stderr out of debug logs without detailed opt-in", async () => {
    vi.stubEnv("ARDUR_DETAILED_PROCESS_LOGS", undefined);
    vi.stubEnv("LOG_LEVEL", "debug");
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const f = fixture();
      f.loaded.whileStarting = () => {
        (f.child.stderr as PassThrough).write(`${"a1".repeat(32)}\n${"b2".repeat(32)}\n`);
      };
      expect(await f.collect()).toContainEqual({ type: "done" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      vi.unstubAllEnvs();
    }
  });

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
  /** A scratch folder, spelled as the disk spells it (the system temp folder is itself a link). */
  const scratch = async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "codex-grants-")));
    return root;
  };
  const refused = (f: ReturnType<typeof fixture>, runtime: CodexAppServerRuntime) =>
    (async () => {
      for await (const _event of runtime.run(f.request)) {
        // drain
      }
    })();
  it.each(["thread/start", "thread/resume"] as const)(
    "hands Codex the project instructions as text and grants only the folder for %s",
    async (method) => {
      const repo = path.join(await scratch(), "repo");
      const folder = path.join(repo, "a", "b");
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(repo, "AGENTS.md"), "root rules\n");
      await writeFile(path.join(repo, "a", "AGENTS.override.md"), "area rules");
      await writeFile(path.join(folder, "AGENTS.md"), "folder rules");
      const f = fixture();
      f.request.nativeCwd = folder;
      if (method === "thread/resume")
        f.request.nativeSession = { runtimeKind: "codex-app-server", sessionId: "thread-native" };
      await f.collect();
      const start = f.messages.find((event) => event.method === method);
      const config = start?.params?.config as {
        project_doc_max_bytes?: number;
        permissions?: { "ardur-read": { filesystem: Record<string, string> } };
      };
      // Codex opens no file for project instructions, so none is granted.
      expect(config.project_doc_max_bytes).toBe(0);
      expect(config.permissions?.["ardur-read"].filesystem).toEqual({
        ":minimal": "read",
        [folder]: "read",
      });
      const text = start?.params?.baseInstructions as string;
      expect(text.startsWith("Your Codex sandbox is read-only")).toBe(true);
      expect(text.split("\n\n").slice(1)).toEqual([
        "bot instructions",
        "Project instructions (from the folder's instruction files):",
        "root rules",
        "area rules",
        "folder rules",
      ]);
    },
  );
  it("sends the bot's own instructions alone when the folder has no instruction files", async () => {
    const folder = path.join(await scratch(), "bot");
    await mkdir(folder, { recursive: true });
    const f = fixture();
    f.request.nativeCwd = folder;
    await f.collect();
    const start = f.messages.find((event) => event.method === "thread/start");
    const text = start?.params?.baseInstructions as string;
    expect(text.startsWith("Your Codex sandbox is read-only")).toBe(true);
    expect(text.endsWith("\n\nbot instructions")).toBe(true);
    expect(text).not.toContain("Project instructions");
    expect(start?.params?.config).toMatchObject({ project_doc_max_bytes: 0 });
  });
  it.each(["thread/start", "thread/resume"] as const)(
    "refuses an instruction file that links outside the project for %s",
    async (method) => {
      const folder = path.join(await scratch(), "bot");
      const vault = path.join(root, "vault");
      await mkdir(folder, { recursive: true });
      await mkdir(vault, { recursive: true });
      await writeFile(path.join(vault, "secret.txt"), "protected");
      await symlink(path.join(vault, "secret.txt"), path.join(folder, "AGENTS.md"));
      const f = fixture();
      f.request.nativeCwd = folder;
      if (method === "thread/resume")
        f.request.nativeSession = { runtimeKind: "codex-app-server", sessionId: "thread-native" };
      await expect(f.collect()).rejects.toMatchObject({
        problem: {
          code: "runtime-unavailable",
          reason:
            "Codex can't start: Ardur can't safely read AGENTS.md for this bot. Replace it with a plain file.",
        },
      });
      expect(f.messages.some((event) => event.method === method)).toBe(false);
      expect(f.messages.some((event) => event.method === "turn/start")).toBe(false);
    },
  );
  it("reads no instruction file for a controlled comparison, even an unsafe one", async () => {
    const folder = path.join(await scratch(), "bot");
    const vault = path.join(root, "vault");
    await mkdir(folder, { recursive: true });
    await mkdir(vault, { recursive: true });
    await writeFile(path.join(vault, "secret.txt"), "protected");
    await symlink(path.join(vault, "secret.txt"), path.join(folder, "AGENTS.md"));
    const f = fixture();
    f.request.nativeCwd = folder;
    f.request.controlledComparison = true;
    await f.collect();
    const start = f.messages.find((event) => event.method === "thread/start");
    expect(start?.params?.baseInstructions).toBe("bot instructions");
    expect(start?.params?.config).toMatchObject({
      project_doc_max_bytes: 0,
      developer_instructions: "",
    });
  });
  describe("what Codex says it loaded", () => {
    const refusal = {
      problem: {
        code: "runtime-unavailable",
        reason:
          "Codex can't start: an instructions file it loaded changed or points at protected data. Check the file in Codex's folder and try again.",
      },
    };
    /** Codex's own folder with its instruction file, last changed a while ago. */
    const codexHome = async () => {
      const home = path.join(await scratch(), "codex-home");
      await mkdir(home, { recursive: true });
      const file = path.join(home, "AGENTS.md");
      await writeFile(file, "the person's own rules");
      // A file changed within the clock's slack before the ask is refused; let it settle.
      await new Promise((resolve) => setTimeout(resolve, INSTRUCTION_CHANGE_SLACK_MS + 50));
      return file;
    };
    it("starts the turn when the file is ordinary and unchanged", async () => {
      const file = await codexHome();
      const f = fixture();
      f.loaded.instructionSources = [file];
      const events = await f.collect();
      expect(events.some((event) => event.type === "done")).toBe(true);
      expect(f.messages.some((event) => event.method === "turn/start")).toBe(true);
    });
    it("sends no turn when the file points at protected data", async () => {
      const file = await codexHome();
      const data = path.join(root, "data");
      await mkdir(data, { recursive: true });
      await writeFile(path.join(data, "secrets.env"), "KEY=1");
      await rm(file);
      await symlink(path.join(data, "secrets.env"), file);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const f = fixture();
      f.loaded.instructionSources = [file];
      const runtime = new CodexAppServerRuntime(f.spawn, { paths: [data], ports: [], sockets: [] });
      await expect(refused(f, runtime)).rejects.toMatchObject(refusal);
      expect(f.messages.some((event) => event.method === "turn/start")).toBe(false);
      expect(f.info).not.toHaveBeenCalled();
    });
    it("sends no turn when the file was swapped while the session started, then put back", async () => {
      const file = await codexHome();
      const f = fixture();
      f.loaded.instructionSources = [file];
      f.loaded.whileStarting = () => {
        renameSync(file, `${file}.kept`);
        symlinkSync("/nowhere", file);
        rmSync(file);
        renameSync(`${file}.kept`, file);
      };
      await expect(f.collect()).rejects.toMatchObject(refusal);
      expect(f.messages.some((event) => event.method === "turn/start")).toBe(false);
      expect(f.info).not.toHaveBeenCalled();
    });
    it("sends no turn when Codex does not say what it loaded", async () => {
      const f = fixture();
      f.loaded.omitInstructionSources = true;
      await expect(f.collect()).rejects.toMatchObject(refusal);
      expect(f.messages.some((event) => event.method === "turn/start")).toBe(false);
      expect(f.info).not.toHaveBeenCalled();
    });
    it("sends no turn when Codex loaded a file from the project all the same", async () => {
      const folder = path.join(await scratch(), "bot");
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "AGENTS.md"), "folder rules");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const f = fixture();
      f.request.nativeCwd = folder;
      f.loaded.instructionSources = [path.join(folder, "AGENTS.md")];
      await expect(f.collect()).rejects.toMatchObject(refusal);
      expect(f.messages.some((event) => event.method === "turn/start")).toBe(false);
    });
  });
  it("grants the folder as the disk spells it, and refuses one that links into protected data", async () => {
    const data = path.join(await scratch(), "data");
    const home = path.join(data, "desktop-computers", "team-a");
    const secrets = path.join(data, "homes");
    await mkdir(home, { recursive: true });
    await mkdir(secrets, { recursive: true });
    const guard = { paths: [secrets], ports: [], sockets: [] };

    const alias = path.join(root, "alias");
    await symlink(home, alias);
    const open = fixture();
    open.request.nativeCwd = alias;
    for await (const _event of new CodexAppServerRuntime(open.spawn, guard).run(open.request)) {
      // drain
    }
    const start = open.messages.find((event) => event.method === "thread/start");
    const config = start?.params?.config as {
      permissions: { "ardur-read": { filesystem: Record<string, string> } };
    };
    expect(config.permissions["ardur-read"].filesystem).toEqual({
      ":minimal": "read",
      [home]: "read",
    });
    // Codex's own sandbox cannot enter a folder reached through a link, so it gets the real one.
    expect(start?.params?.cwd).toBe(home);
    expect((open.spawn.mock.calls[0] as unknown[])[2]).toBe(home);

    const planted = path.join(data, "desktop-computers", "team-b");
    await symlink(secrets, planted);
    const closed = fixture();
    closed.request.nativeCwd = planted;
    await expect(
      refused(closed, new CodexAppServerRuntime(closed.spawn, guard)),
    ).rejects.toMatchObject({
      problem: {
        code: "runtime-unavailable",
        reason:
          "Codex could not start a session in this bot's folder \u2014 change the bot's computer or the pin.",
      },
    });
    expect(closed.spawn).not.toHaveBeenCalled();
  });
  describe("a bot folder swapped for a link into protected data", () => {
    const folderRefusal = {
      problem: {
        code: "runtime-unavailable",
        reason:
          "Codex could not start a session in this bot's folder \u2014 change the bot's computer or the pin.",
      },
    };
    const planted = async () => {
      const data = path.join(await scratch(), "data");
      const home = path.join(data, "desktop-computers", "team-a");
      const secrets = path.join(data, "homes");
      await mkdir(home, { recursive: true });
      await mkdir(secrets, { recursive: true });
      const swap = () => {
        renameSync(home, `${home}.kept`);
        symlinkSync(secrets, home);
      };
      return { home, guard: { paths: [secrets], ports: [], sockets: [] }, swap };
    };
    it("asks for no session when the swap happens after the first look", async () => {
      const { home, guard, swap } = await planted();
      const f = fixture();
      f.request.nativeCwd = home;
      f.loaded.whileConfiguring = swap;
      await expect(refused(f, new CodexAppServerRuntime(f.spawn, guard))).rejects.toMatchObject(
        folderRefusal,
      );
      expect(f.messages.some((event) => event.method === "thread/start")).toBe(false);
    });
    it("sends no turn when the swap happens while the session starts", async () => {
      const { home, guard, swap } = await planted();
      const f = fixture();
      f.request.nativeCwd = home;
      f.loaded.whileStarting = swap;
      await expect(refused(f, new CodexAppServerRuntime(f.spawn, guard))).rejects.toMatchObject(
        folderRefusal,
      );
      expect(f.messages.some((event) => event.method === "turn/start")).toBe(false);
      expect(f.info).not.toHaveBeenCalled();
    });
    it.each([
      ["another folder", "/somewhere/else"],
      ["no folder", undefined],
    ])("sends no turn when Codex answers with %s", async (_label, cwd) => {
      const { home, guard } = await planted();
      const f = fixture();
      f.request.nativeCwd = home;
      f.loaded.cwd = cwd;
      await expect(refused(f, new CodexAppServerRuntime(f.spawn, guard))).rejects.toMatchObject(
        folderRefusal,
      );
      expect(f.messages.some((event) => event.method === "turn/start")).toBe(false);
    });
  });
  it("refuses a bot folder that overlaps Ardur's protected data, before Codex starts", async () => {
    // Codex runs under its own sandbox, so the protected paths are enforced on its profile.
    const guard = { paths: ["/fixture/ardur/data/homes"], ports: [], sockets: [] };
    for (const folder of ["/fixture/ardur/data/homes/bot-a", "/fixture/ardur/data"]) {
      const f = fixture();
      const runtime = new CodexAppServerRuntime(f.spawn, guard);
      f.request.nativeCwd = folder;
      await expect(refused(f, runtime)).rejects.toMatchObject({
        problem: {
          code: "runtime-unavailable",
          reason:
            "Codex could not start a session in this bot's folder \u2014 change the bot's computer or the pin.",
        },
      });
      expect(f.spawn).not.toHaveBeenCalled();
    }
  });
  it("starts in a folder outside Ardur's protected data", async () => {
    const guard = { paths: ["/fixture/ardur/data/homes"], ports: [], sockets: [] };
    const f = fixture();
    const runtime = new CodexAppServerRuntime(f.spawn, guard);
    f.request.nativeCwd = "/fixture/ardur/data/desktop-computers/team-a";
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(f.request)) events.push(event);
    expect(events.some((event) => event.type === "done")).toBe(true);
    const launched = f.spawn.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(launched.length).toBeGreaterThan(0);
    expect(launched).not.toContain("/usr/bin/sandbox-exec");
  });
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
