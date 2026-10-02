import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { HermesExecutionEnvelopeSchema } from "@ardurbot/contracts/runtime-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../../logging/src/logger.js";
import { createTestSink } from "../../../logging/src/test-sink.js";
import profileFixture from "../../python/tests/valid_profile.json" with { type: "json" };
import { createChildProcessLogger } from "../child-output.js";
import { createArdurToolBridge } from "./claude-mcp-bridge.js";
import {
  createHermesTextRedactor,
  HermesRuntime,
  hermesContextDocument,
  launchUnconfinedProcess,
} from "./hermes-runtime.js";
import { stopNative } from "./native-process.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    botId: "bot-fixture",
    threadId: "thread-fixture",
    runId: crypto.randomUUID(),
    prompt: "Hello",
    instructions: "Use the provided tools only.",
    history: [],
    tools: "none",
    model: {
      provider: "custom:ardur",
      id: "fixture-model",
      baseUrl: "http://127.0.0.1:7777/v1",
      apiKey: "fixture-provider-key-123",
      thinkingLevel: "high",
    },
    ...overrides,
  };
}

async function collect(runtime: HermesRuntime, run: AgentRunRequest, signal?: AbortSignal) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(run, { signal })) events.push(event);
  return events;
}

function runtime(scenario: string, onPermissionAttempt?: () => void) {
  return new HermesRuntime({
    command: process.execPath,
    args: [fixture, scenario],
    launch: launchUnconfinedProcess,
    onPermissionAttempt,
  });
}

type TurnFinishReason = "done" | "pause" | "failure" | "cancel";

function turnFinishSignal(runId: string) {
  const calls: TurnFinishReason[] = [];
  let resolve!: (reason: TurnFinishReason) => void;
  const finished = new Promise<TurnFinishReason>((settle) => {
    resolve = settle;
  });
  return {
    calls,
    finished,
    onTurnFinished: (finishedRunId: string, reason: TurnFinishReason) => {
      if (finishedRunId === runId) {
        calls.push(reason);
        resolve(reason);
      }
    },
  };
}

describe("HermesRuntime M0 ACP seam", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ["session-new-error", false],
    ["session-new-error", true],
    ["session-new-long-error", false],
    ["session-new-long-error", true],
  ] as const)(
    "logs only safe protocol metadata for %s (detailed=%s)",
    async (scenario, detailed) => {
      vi.stubEnv("ARDUR_DETAILED_PROCESS_LOGS", detailed ? "1" : undefined);
      vi.stubEnv("LOG_LEVEL", "debug");
      const records: string[] = [];
      const sink = new Writable({
        write(chunk, _encoding, done) {
          records.push(String(chunk));
          done();
        },
      });
      const run = request();
      run.model.runtimePin = {
        runtimeKind: "hermes",
        provider: "fixture",
        modelId: "fixture-model",
        effort: "high",
        credentialId: "fixture-connection",
        revision: 1,
      };
      const adapter = new HermesRuntime({
        command: process.execPath,
        args: [fixture, scenario],
        launch: async (spec) => ({
          ...(await launchUnconfinedProcess(spec)),
          mcpConfig: {
            command: "fixture",
            args: ["bridge", "fixture-bridge-argument"],
            env: { BRIDGE_TOKEN: "fixture-bridge-environment" },
          },
        }),
        logger: createChildProcessLogger(sink),
      });
      try {
        const failure = await collect(adapter, run).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          name: "RuntimePinError",
          problem: {
            reasonId: "session-start-failed",
            reason: "Hermes could not start a session. Check the runtime and try again.",
          },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        const failures = records
          .map((line) => JSON.parse(line))
          .filter((record) => record.level === "error");
        expect(failures).toHaveLength(1);
        expect(failures[0].message).toBe("Hermes turn failed");
        const facts = JSON.parse(failures[0].error.message);
        const prefix = "session refused: [redacted] [redacted] [redacted]";
        expect(facts).toMatchObject({
          kind: "ACP handshake failed",
          phase: "session/new",
          acpFailure: "protocol-error",
          protocolErrorCode: -32602,
          protocolErrorMessage:
            scenario === "session-new-long-error"
              ? `${prefix} ${"x".repeat(500)}`.slice(0, 300)
              : prefix,
        });
        expect(facts.protocolErrorMessage.length).toBeLessThanOrEqual(300);
        const logged = records.join("");
        for (const privateText of [
          run.model.apiKey!,
          "fixture-bridge-argument",
          "fixture-bridge-environment",
          "fixture private error data",
          "fixture private prompt",
        ])
          expect(logged).not.toContain(privateText);
        expect(JSON.stringify(failure)).not.toContain("session refused:");
        expect((failure as Error).cause).toMatchObject({
          message: expect.stringContaining("phase: session/new"),
        });
        expect(((failure as Error).cause as Error).cause).toBeUndefined();
      } finally {
        sink.destroy();
      }
    },
  );

  it("records a child closing during session/new as closed, not a protocol refusal", async () => {
    const error = vi.fn();
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "session-new-closed"],
      launch: launchUnconfinedProcess,
      logger: { debug: vi.fn(), error },
    });
    await expect(collect(adapter, request())).rejects.toThrow(
      "Hermes could not start a session. Check the runtime and try again.",
    );
    expect(error).toHaveBeenCalledExactlyOnceWith(
      "Hermes turn failed",
      expect.objectContaining({
        kind: "ACP handshake failed",
        phase: "session/new",
        acpFailure: "closed",
        exitCode: 4,
        protocolErrorCode: undefined,
        protocolErrorMessage: undefined,
      }),
    );
  });
  it("redacts provider and overridden bridge credentials from child stderr", async () => {
    vi.stubEnv("ARDUR_DETAILED_PROCESS_LOGS", "1");
    const debug: string[] = [];
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "stderr-bridge"],
      launch: async (spec) => ({
        ...(await launchUnconfinedProcess(spec)),
        mcpConfig: {
          command: "fixture",
          args: ["bridge", "a1".repeat(32)],
          env: { BRIDGE_TOKEN: "b2".repeat(32) },
        },
      }),
      logger: {
        debug: (message) => {
          debug.push(message);
        },
      },
    });
    await collect(adapter, request()).catch(() => undefined);
    expect(debug.join("\n")).toContain("hermes stderr: [redacted]");
    expect(debug.join("\n")).not.toContain("a1".repeat(32));
    expect(debug.join("\n")).not.toContain("b2".repeat(32));
    expect(debug.join("\n")).not.toContain(request().model.apiKey!);
  });

  it.each(["info", "debug"] as const)(
    "keeps all child content out of fallback and worker logs by default at %s",
    async (level) => {
      vi.stubEnv("ARDUR_DETAILED_PROCESS_LOGS", undefined);
      vi.stubEnv("LOG_LEVEL", level);
      const records: string[] = [];
      const sink = new Writable({
        write(chunk, _encoding, done) {
          records.push(String(chunk));
          done();
        },
      });
      const fallback = createChildProcessLogger(sink);
      const debug = vi.fn((message: string, bindings?: Record<string, unknown>) =>
        fallback.debug(message, bindings),
      );
      const adapter = new HermesRuntime({
        command: process.execPath,
        args: [fixture, "stderr-failure"],
        launch: launchUnconfinedProcess,
        logger: { ...fallback, debug },
      });
      try {
        const failure = await collect(adapter, request()).catch((error: unknown) => error);
        const workerSink = createTestSink();
        createLogger({ service: "fixture-worker", level, sinks: [workerSink] }).error(
          "Run failed",
          failure,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        const combined = records.join("") + JSON.stringify(workerSink.events);
        expect(debug).not.toHaveBeenCalled();
        expect(combined).not.toMatch(
          /fixture diagnostic before failure|fixture prompt contents|fixture document contents|fixture-key-123/,
        );
        expect(combined).toContain("prompt");
        expect(combined).toContain("durationMs");
        const host = JSON.parse(records[0]!);
        expect(JSON.parse(host.error.message)).toMatchObject({
          phase: "prompt",
          exitCode: 4,
          durationMs: expect.any(Number),
          byteCount: expect.any(Number),
          lineCount: expect.any(Number),
          outputProduced: true,
        });
      } finally {
        sink.destroy();
        vi.unstubAllEnvs();
      }
    },
  );

  const profile = HermesExecutionEnvelopeSchema.parse(profileFixture);
  const profileRequest = () => {
    const base = request();
    return request({
      model: {
        ...base.model,
        maxTokens: 1_024,
        contextWindow: 32_768,
        reasoning: true,
        acceptsImages: false,
        runtimePin: {
          runtimeKind: "hermes",
          provider: "fixture",
          modelId: "fixture-model",
          effort: "high",
          credentialId: "fixture-connection",
          revision: 1,
        },
      },
    });
  };
  it("stages the compiled policy and waits for a matching session acknowledgment", async () => {
    let staged: Record<string, unknown> | undefined;
    let environment: Record<string, string> | undefined;
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "profile-ack"],
      pinned: true,
      executionEnvelope: profile,
      launch: async (spec) => {
        environment = spec.env;
        staged = JSON.parse(await readFile(join(spec.env.HERMES_HOME!, "config.yaml"), "utf8"));
        return launchUnconfinedProcess(spec);
      },
    });
    expect((await collect(adapter, profileRequest())).at(-1)).toEqual({ type: "done" });
    expect(staged).toEqual(profile.effectiveRuntimeConfig.generatedConfig);
    expect(environment).toMatchObject({
      ARDUR_HERMES_PROFILE: "hermes-ardur-v2",
      ARDUR_HERMES_MAX_ITERATIONS: "16",
      ARDUR_HERMES_RUN_BUDGET_SECONDS: "180",
      HERMES_DISABLE_LAZY_INSTALLS: "1",
      PATH: "/usr/bin:/bin",
    });
  });
  it("excludes native child requests from the acknowledged Ardur catalog", async () => {
    const run = profileRequest();
    run.tools = [
      { name: "run_subagent", description: "Child", inputSchema: { type: "object" } },
      { name: "fixture_echo", description: "Echo", inputSchema: { type: "object" } },
    ];
    let catalog: string[] = [];
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "profile-ack"],
      pinned: true,
      executionEnvelope: profile,
      launch: async (spec) => {
        catalog = JSON.parse(spec.env.ARDUR_HERMES_ALLOWED_TOOLS!);
        return launchUnconfinedProcess(spec);
      },
    });
    expect((await collect(adapter, run)).at(-1)).toEqual({ type: "done" });
    expect(catalog).toEqual(["mcp__ardur__fixture_echo"]);
  });
  it.each(["text", "profile-stale"])(
    "refuses a %s acknowledgment before prompting and removes staging",
    async (scenario) => {
      let home = "";
      const adapter = new HermesRuntime({
        command: process.execPath,
        args: [fixture, scenario],
        pinned: true,
        executionEnvelope: profile,
        launch: async (spec) => {
          home = spec.env.HERMES_HOME!;
          return launchUnconfinedProcess(spec);
        },
      });
      await expect(collect(adapter, profileRequest())).rejects.toThrow();
      expect(existsSync(home)).toBe(false);
    },
  );
  it("denies tool effects attempted during construction before acknowledgment", async () => {
    const executeTool = vi.fn(async () => ({ text: "should not run" }));
    const run = profileRequest();
    run.tools = [{ name: "fixture_echo", description: "Echo", inputSchema: { type: "object" } }];
    run.executeTool = executeTool;
    let constructionResult: { isError: boolean } | undefined;
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "profile-construction-tool"],
      pinned: true,
      executionEnvelope: profile,
      launch: async (spec) => {
        const launched = await launchUnconfinedProcess(spec);
        return {
          ...launched,
          teardown: async () => {
            constructionResult = JSON.parse(
              await readFile(join(spec.env.HERMES_HOME!, "construction-result.json"), "utf8"),
            );
            await launched.teardown();
          },
        };
      },
    });
    await expect(collect(adapter, run)).rejects.toThrow();
    expect(constructionResult).toEqual({ isError: true });
    expect(executeTool).not.toHaveBeenCalled();
  });
  it("refuses a forged profile before any child launch", async () => {
    const forged = structuredClone(profile);
    forged.effectiveRuntimeConfig.generatedConfig.compression = { enabled: true };
    const launch = vi.fn(launchUnconfinedProcess);
    const adapter = new HermesRuntime({
      command: process.execPath,
      pinned: true,
      executionEnvelope: forged,
      launch,
    });
    await expect(collect(adapter, profileRequest())).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });
  it("uses a 600-second pinned ACP prompt deadline with bounded teardown grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let promptStarted!: () => void;
    const prompted = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(() => {
        fakeChild.exitCode = 0;
        fakeChild.emit("close", 0);
        return true;
      }),
    });
    const child = fakeChild as unknown as ChildProcessWithoutNullStreams;
    stdin.on("data", (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString()) as { id: number; method: string };
      if (message.method === "session/prompt") {
        promptStarted();
        return;
      }
      const result =
        message.method === "initialize" ? { protocolVersion: 1 } : { sessionId: "fixture-session" };
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    });
    const finished = vi.fn();
    const error = vi.fn();
    const adapter = new HermesRuntime({
      command: "fixture",
      pinned: true,
      launch: async () => ({ child, teardown: async () => undefined }),
      onTurnFinished: finished,
      logger: { debug: vi.fn(), error },
    });
    const base = request();
    const run = request({
      model: {
        ...base.model,
        maxTokens: 1_024,
        contextWindow: 32_768,
        runtimePin: {
          runtimeKind: "hermes",
          provider: "openai-compatible",
          modelId: "fixture-model",
          effort: "high",
          credentialId: "fixture-connection",
          revision: 1,
          runtimeConfig: { version: 1, maxProviderRequests: 4, timeoutMs: 600_000 },
        },
      },
    });
    try {
      let settled = false;
      const completion = collect(adapter, run).finally(() => {
        settled = true;
      });
      await prompted;
      await vi.advanceTimersByTimeAsync(181_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      expect(finished).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(423_200);
      await expect(completion).rejects.toThrow("Hermes could not complete this turn.");
      expect(error).toHaveBeenCalledWith(
        "Hermes turn failed",
        expect.objectContaining({
          phase: "prompt",
          acpFailure: "timeout",
          protocolErrorCode: undefined,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps instructions and the newest quoted history within the pinned context budget", () => {
    const history = Array.from({ length: 18 }, (_, index) => ({
      role: "user" as const,
      content: `turn-${index} ${"x".repeat(2_000)}`,
    }));
    const document = hermesContextDocument(
      request({
        instructions: "Required owner instruction",
        history,
      }),
    );
    expect(Buffer.byteLength(document)).toBeLessThanOrEqual(16 * 1024);
    expect(document).toContain("Required owner instruction");
    expect(document).toContain("turn-17");
    expect(document).not.toContain("turn-0");
    expect(document).toContain("[truncated]");
  });
  it("drops the teammate directory before quoted conversation", () => {
    const question = "Where is the launch checklist?";
    const history = [
      { role: "user" as const, content: "<thread_summary>\nFriday launch.\n</thread_summary>" },
      { role: "user" as const, content: question },
      { role: "assistant" as const, content: "Nine of fourteen items are done." },
      {
        role: "user" as const,
        content: "<teammate_directory>\nWriter: busy\n</teammate_directory>",
      },
      { role: "user" as const, content: "<group_brief>\nPricing table\n</group_brief>" },
      { role: "user" as const, content: "Completed assignment: pricing table checked." },
      { role: "user" as const, content: "<recalled_memory>\nThree bullets.\n</recalled_memory>" },
    ];
    const run = request({ instructions: "Required owner instruction", history });
    const full = hermesContextDocument(run, { maxInputBytes: 1024 * 1024, overflow: "trim" });
    const document = hermesContextDocument(run, {
      maxInputBytes: Buffer.byteLength(full) - 1,
      overflow: "trim",
    });
    expect(document).toContain(question);
    expect(document).toContain("Nine of fourteen items are done.");
    expect(document).toContain("Completed assignment: pricing table checked.");
    expect(document).toContain("<thread_summary>");
    expect(document).toContain("<group_brief>");
    expect(document).toContain("<recalled_memory>");
    expect(document).not.toContain("<teammate_directory>");
    expect(document).toContain("[truncated]");
  });
  it("refuses required instructions alone above the pinned context budget", () => {
    expect(() =>
      hermesContextDocument(request({ instructions: "x".repeat(16 * 1024 + 1) })),
    ).toThrow("Hermes instructions exceed the context limit. Shorten the bot instructions.");
  });
  it("honors the selected byte ceiling and stop policy without splitting Unicode", () => {
    const run = request({
      instructions: "Required instruction",
      history: [{ role: "user", content: "🙂".repeat(4_000) }],
    });
    expect(() => hermesContextDocument(run, { maxInputBytes: 4_096, overflow: "stop" })).toThrow(
      "Context exceeds the selected limit.",
    );
    const result = hermesContextDocument(run, { maxInputBytes: 4_096, overflow: "trim" });
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(4_096);
    expect(result).toContain("Required instruction");
    expect(result).not.toContain("�");
  });
  it("refuses a pinned turn without validated limits before launch", async () => {
    const launch = vi.fn(launchUnconfinedProcess);
    const adapter = new HermesRuntime({ command: process.execPath, pinned: true, launch });
    const base = request();
    await expect(
      collect(
        adapter,
        request({
          model: { ...base.model, maxTokens: 1_024, contextWindow: 32_768 },
        }),
      ),
    ).rejects.toThrow("The recorded Hermes limits are missing or invalid. Change the pin.");
    expect(launch).not.toHaveBeenCalled();
  });
  it("passes snapshot limits to the pinned launcher through a synthetic turn", async () => {
    let env: Record<string, string> | undefined;
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "text"],
      pinned: true,
      launch: async (spec) => {
        env = spec.env;
        return launchUnconfinedProcess(spec);
      },
    });
    const base = request();
    const run = request({
      model: {
        ...base.model,
        maxTokens: 1_024,
        contextWindow: 32_768,
        runtimePin: {
          runtimeKind: "hermes",
          provider: "openai-compatible",
          modelId: "fixture-model",
          effort: "high",
          credentialId: "fixture-connection",
          revision: 2,
          runtimeConfig: { version: 1, maxProviderRequests: 7, timeoutMs: 42_000 },
        },
      },
    });
    expect((await collect(adapter, run)).at(-1)).toEqual({ type: "done" });
    expect(env?.ARDUR_HERMES_MAX_ITERATIONS).toBe("7");
    expect(env?.ARDUR_HERMES_RUN_BUDGET_SECONDS).toBe("42");
  });
  it("requires an explicit launcher at construction", () => {
    expect(
      () =>
        new HermesRuntime({
          command: process.execPath,
          args: [fixture, "text"],
        } as ConstructorParameters<typeof HermesRuntime>[0]),
    ).toThrow("Hermes needs an explicit launcher.");
  });

  it("handshakes, streams text once and completes without manufactured usage", async () => {
    const info = vi.fn(async () => {});
    const events = await collect(runtime("text"), request({ onRuntimeInfo: info }));
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("first second");
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.some((event) => event.type === "usage")).toBe(false);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ effortAttested: false, runtimeKind: "hermes" }),
    );
  });

  it("drains a single-write burst of 600 text updates without overflowing", async () => {
    const events = await collect(runtime("text-burst"), request());
    const textEvents = events.filter((event) => event.type === "text");
    expect(textEvents.map((event) => event.text).join("")).toBe("x".repeat(600));
    expect(textEvents.length).toBeLessThan(16);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("executes one MCP call through the real bridge in authorization order", async () => {
    const order: string[] = [];
    const events = await collect(
      runtime("tool"),
      request({
        tools: [{ name: "fixture_echo", description: "Echo", inputSchema: { type: "object" } }],
        authorizeTool: async () => {
          order.push("authorize");
          return undefined;
        },
        executeTool: async (_name, _args, id) => {
          expect(id).toContain(":");
          order.push("execute");
          return { echoed: "hello" };
        },
        onToolCompleted: async () => {
          order.push("complete");
        },
      }),
    );
    expect(order).toEqual(["authorize", "execute", "complete"]);
    expect(events.filter((event) => event.type === "tool")).toHaveLength(1);
    expect(events.some((event) => event.type === "progress")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("fails closed on a native tool observation", async () => {
    await expect(collect(runtime("native"), request())).rejects.toThrow(
      "Hermes tried to use a tool this bot was not given.",
    );
  });

  it("fails closed on an unlisted tool using the Ardur MCP name prefix", async () => {
    await expect(collect(runtime("foreign-mcp"), request())).rejects.toThrow(
      "Hermes tried to use a tool this bot was not given.",
    );
  });

  for (const [scenario, name, eventType] of [
    ["ask-user", "ask_user", "ask"],
    ["takeover", "request_takeover", "takeover"],
  ] as const) {
    it(`delivers one ${eventType} event before the bridge pauses`, async () => {
      const executeTool = vi.fn(async () => ({ unexpected: true }));
      const events = await collect(
        runtime(scenario),
        request({
          tools: [{ name, description: name, inputSchema: { type: "object" } }],
          executeTool,
        }),
      );
      expect(events.filter((event) => event.type === eventType)).toHaveLength(1);
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(executeTool).not.toHaveBeenCalled();
    });
  }

  it("drops a queued ask when an aborted consumer resumes after a bridge pause", async () => {
    let pauseObserved!: () => void;
    const paused = new Promise<void>((resolve) => {
      pauseObserved = resolve;
    });
    const adapter = runtime("ask-user");
    const run = request({
      tools: [{ name: "ask_user", description: "Ask", inputSchema: { type: "object" } }],
      executeTool: vi.fn(async () => ({ unexpected: true })),
      onToolCompleted: async ({ paused: didPause }) => {
        if (didPause) pauseObserved();
      },
    });
    const events = adapter.run(run)[Symbol.asyncIterator]();
    try {
      expect((await events.next()).done).toBe(false);
      await paused;
      await adapter.abort(run.runId);
      expect(await events.next()).toEqual({ value: undefined, done: true });
      expect(run.executeTool).not.toHaveBeenCalled();
    } finally {
      await events.return?.();
    }
  });

  it("flushes held text before the ask that pauses the turn", async () => {
    const events = await collect(
      runtime("ask-user-held-text"),
      request({
        tools: [{ name: "ask_user", description: "Ask", inputSchema: { type: "object" } }],
        executeTool: vi.fn(async () => ({ unexpected: true })),
      }),
    );
    const textAndAsk = events.filter((event) => event.type === "text" || event.type === "ask");
    expect(textAndAsk.map((event) => event.type)).toEqual(["text", "text", "ask"]);
    expect(
      textAndAsk
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("Please approve the diff");
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("flushes held text before a tool result pauses the turn", async () => {
    const events = await collect(
      runtime("tool-held-text"),
      request({
        tools: [{ name: "fixture_echo", description: "Echo", inputSchema: { type: "object" } }],
        executeTool: async () => ({
          kind: "agent_tool_result",
          terminate: true,
          details: { approval: "paused" },
          content: [],
        }),
      }),
    );
    const textAndTool = events.filter((event) => event.type === "text" || event.type === "tool");
    expect(textAndTool.map((event) => event.type)).toEqual(["text", "text", "tool"]);
    expect(
      textAndTool
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("Please approve the diff");
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("keeps held text across an ordinary tool event", async () => {
    const events = await collect(
      runtime("tool-held-text-complete"),
      request({
        tools: [{ name: "fixture_echo", description: "Echo", inputSchema: { type: "object" } }],
        executeTool: async () => ({ echoed: "hello" }),
      }),
    );
    const textAndTool = events.filter((event) => event.type === "text" || event.type === "tool");
    expect(textAndTool.map((event) => event.type)).toEqual(["text", "tool", "text"]);
    expect(textAndTool[0]).toMatchObject({ type: "text", text: "Please approve the dif" });
    expect(textAndTool.at(-1)).toMatchObject({ type: "text", text: "f after tool" });
    expect(events.map((event) => (event.type === "text" ? event.text : "")).join("")).not.toContain(
      "fixture-provider-key-123",
    );
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  for (const kind of ["provider", "relay"] as const) {
    it(`holds a ${kind} prefix across an ordinary bridge tool event`, async () => {
      const relay = "a1".repeat(32);
      const run = request({
        tools: [{ name: "fixture_echo", description: "Echo", inputSchema: { type: "object" } }],
        executeTool: async () => ({ echoed: "hello" }),
      });
      const secret = kind === "provider" ? run.model.apiKey! : relay;
      const events: AgentRuntimeEvent[] = [];
      const emitText = createHermesTextRedactor([run.model.apiKey!, relay], (text) => {
        events.push({ type: "text", text });
      });
      const pause = vi.fn();
      const bridge = createArdurToolBridge(
        run,
        (event) => events.push(event),
        pause,
        () => true,
        () => emitText("", true),
      );
      emitText(`before ${secret.slice(0, 4)}`);
      await bridge.call("fixture_echo", { value: "hello" });
      emitText(`${secret.slice(4)} after tool`);
      emitText("", true);

      const text = events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      expect(text.includes(secret)).toBe(false);
      expect(text.includes("[redacted]")).toBe(true);
      expect(events.map((event) => event.type)).toEqual(["text", "tool", "text"]);
      expect(events.some((event) => event.type === "tool" && event.name === "fixture_echo")).toBe(
        true,
      );
      expect(pause).not.toHaveBeenCalled();
    });

    it(`redacts a ${kind} secret split around a successful tool call`, async () => {
      const run = request({
        prompt: kind,
        tools: [{ name: "fixture_echo", description: "Echo", inputSchema: { type: "object" } }],
        executeTool: async () => ({ echoed: "hello" }),
      });
      const events = await collect(runtime("tool-split-secret"), run);
      const text = events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      expect(
        kind === "provider" ? text.includes(run.model.apiKey!) : /[a-f0-9]{64}/.test(text),
      ).toBe(false);
      expect(text.includes("[redacted]")).toBe(true);
      expect(events.some((event) => event.type === "tool" && event.name === "fixture_echo")).toBe(
        true,
      );
      expect(events.at(-1)).toEqual({ type: "done" });
    });
  }

  for (const scenario of ["held-native", "held-malformed"]) {
    it(`flushes held text before ${scenario} fails`, async () => {
      const text: string[] = [];
      const read = async () => {
        for await (const event of runtime(scenario).run(request())) {
          if (event.type === "text") text.push(event.text);
        }
      };
      await expect(read()).rejects.toThrow();
      expect(text.join("")).toBe("before failure f");
    });
  }

  it("propagates a forbidden tool after text in one ACP write", async () => {
    await expect(collect(runtime("buffered-native"), request())).rejects.toThrow(
      "Hermes tried to use a tool this bot was not given.",
    );
  });

  it("propagates a forbidden tool when the consumer pauses after buffered text", async () => {
    const events = runtime("buffered-native").run(request())[Symbol.asyncIterator]();
    expect(await events.next()).toEqual({
      value: { type: "text", text: "before violation" },
      done: false,
    });
    await expect(events.next()).rejects.toThrow(
      "Hermes tried to use a tool this bot was not given.",
    );
  });

  it("selects the offered reject_once option and records the attempt", async () => {
    const attempted = vi.fn();
    const events = await collect(runtime("permission", attempted), request());
    expect(attempted).toHaveBeenCalledOnce();
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("denied");
  });

  it("rejects client filesystem requests because no capability was advertised", async () => {
    const events = await collect(runtime("client-capabilities"), request());
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("capability denied");
  });

  for (const scenario of [
    "malformed",
    "oversize",
    "exit",
    "poison-text",
    "non-object-content",
  ] as const) {
    it(`ends cleanly when the agent sends ${scenario}`, async () => {
      await expect(collect(runtime(scenario), request())).rejects.toMatchObject({
        message: "Hermes could not complete this turn.",
        cause: { message: expect.stringContaining("kind: ACP protocol failed") },
      });
    });
  }

  it("keeps the stderr tail at debug and only safe facts in failure causes", async () => {
    vi.stubEnv("ARDUR_DETAILED_PROCESS_LOGS", "1");
    const errors: { message: string; error: unknown }[] = [];
    const debugLines: string[] = [];
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "stderr-failure"],
      launch: launchUnconfinedProcess,
      logger: {
        debug: (message) => debugLines.push(message),
        error: (message, error) => errors.push({ message, error }),
      },
    });
    const failure = (await collect(adapter, request()).catch((error: unknown) => error)) as Error;
    expect(failure.message).toBe("Hermes could not complete this turn.");
    const cause = failure.cause as Error;
    expect(cause.message).not.toContain("stderr tail");
    expect(cause.message).not.toContain("fixtu...23");
    expect(cause.message).toContain("exit: 4");
    expect(cause.message).toContain("phase: prompt");
    expect(cause.message).toMatch(/durationMs: \d+/);
    expect(cause.cause).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("Hermes turn failed");
    expect(errors[0]?.error).toMatchObject({
      phase: "prompt",
      exitCode: 4,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(errors)).not.toContain("fixture diagnostic before failure");
    expect(
      debugLines.some((line) => line.includes("hermes stderr: fixture diagnostic before failure")),
    ).toBe(true);
    expect(debugLines.some((line) => line.includes("key=[redacted]"))).toBe(true);
  });

  describe("provider failure classification", () => {
    const pinnedRequest = () => {
      const base = request();
      return request({
        model: {
          ...base.model,
          runtimePin: {
            runtimeKind: "hermes",
            provider: "fixture",
            modelId: "fixture-model",
            effort: "high",
            credentialId: "fixture-connection",
            revision: 1,
          },
        },
      });
    };
    it.each([
      [
        "provider-usage-limit",
        "usage-limit",
        "Hermes's usage limit is reached. Try again after it resets.",
      ],
      ["provider-signed-out", "signed-out", "Sign in to Hermes on this computer, then try again."],
      [
        "provider-model-missing",
        "model-unavailable",
        "Hermes's pinned model is unavailable. Change the pin and try again.",
      ],
    ] as const)(
      "classifies %s as %s without echoing the provider's text",
      async (scenario, reasonId, reason) => {
        const failure = await collect(runtime(scenario), pinnedRequest()).catch(
          (error: unknown) => error,
        );
        expect(failure).toMatchObject({
          name: "RuntimePinError",
          problem: { code: "runtime-unavailable", reasonId, reason },
        });
        expect(JSON.stringify(failure)).not.toContain("HTTP ");
        expect(JSON.stringify(failure)).not.toContain("fixture-pro");
      },
    );
    it("keeps the generic line for an unclassified provider failure", async () => {
      await expect(collect(runtime("provider-unknown"), pinnedRequest())).rejects.toMatchObject({
        message: "Hermes could not complete this turn.",
      });
    });
    it("keeps the generic line when the run carries no pin", async () => {
      await expect(collect(runtime("provider-usage-limit"), request())).rejects.toMatchObject({
        message: "Hermes could not complete this turn.",
      });
    });
  });

  it("fences an authorized tool immediately when ACP fails while the consumer is paused", async () => {
    let authorizationEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      authorizationEntered = resolve;
    });
    let releaseAuthorization!: () => void;
    const heldAuthorization = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let child!: Awaited<ReturnType<typeof launchUnconfinedProcess>>["child"];
    const executeTool = vi.fn(async () => ({ unexpected: true }));
    const run = request({
      tools: [{ name: "fixture_echo", description: "Echo", inputSchema: {} }],
      authorizeTool: async () => {
        authorizationEntered();
        await heldAuthorization;
        return undefined;
      },
      executeTool,
    });
    const finishSignal = turnFinishSignal(run.runId);
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "pending-tool-malformed"],
      launch: async (spec) => {
        const result = await launchUnconfinedProcess(spec);
        child = result.child;
        return result;
      },
      onTurnFinished: finishSignal.onTurnFinished,
    });
    const events = adapter.run(run)[Symbol.asyncIterator]();
    try {
      expect(await events.next()).toEqual({
        value: { type: "text", text: "before protocol failure." },
        done: false,
      });
      await entered;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "fixture/fail-now" })}\n`);
      expect(await finishSignal.finished).toBe("failure");
      releaseAuthorization();
      const drain = async () => {
        while (!(await events.next()).done) {
          // Buffered progress may precede the stored protocol error.
        }
      };
      await expect(drain()).rejects.toMatchObject({
        message: "Hermes could not complete this turn.",
        cause: { message: expect.stringContaining("kind: ACP protocol failed") },
      });
      expect(executeTool).not.toHaveBeenCalled();
    } finally {
      releaseAuthorization();
      await events.return?.();
    }
  });

  it("fences a pending authorization as soon as successful completion is queued", async () => {
    let authorizationEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      authorizationEntered = resolve;
    });
    let releaseAuthorization!: () => void;
    const heldAuthorization = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let child!: Awaited<ReturnType<typeof launchUnconfinedProcess>>["child"];
    const executeTool = vi.fn(async () => ({ unexpected: true }));
    const run = request({
      tools: [{ name: "fixture_echo", description: "Echo", inputSchema: {} }],
      authorizeTool: async () => {
        authorizationEntered();
        await heldAuthorization;
        return undefined;
      },
      executeTool,
    });
    const finishSignal = turnFinishSignal(run.runId);
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "pending-tool-malformed"],
      launch: async (spec) => {
        const result = await launchUnconfinedProcess(spec);
        child = result.child;
        return result;
      },
      onTurnFinished: finishSignal.onTurnFinished,
    });
    const events = adapter.run(run)[Symbol.asyncIterator]();
    try {
      expect(await events.next()).toEqual({
        value: { type: "text", text: "before protocol failure." },
        done: false,
      });
      await entered;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "fixture/finish-now" })}\n`);
      expect(await finishSignal.finished).toBe("done");
      releaseAuthorization();
      const remaining: AgentRuntimeEvent[] = [];
      for await (const event of { [Symbol.asyncIterator]: () => events }) remaining.push(event);
      expect(remaining.at(-1)).toEqual({ type: "done" });
      expect(executeTool).not.toHaveBeenCalled();
    } finally {
      releaseAuthorization();
      await events.return?.();
    }
  });

  for (const transition of [
    "end_turn",
    "bridge pause",
    "forbidden tool",
    "protocol failure",
    "queue overflow",
    "abort",
    "signal",
  ] as const) {
    it(`keeps the bridge fenced after ${transition}`, async () => {
      let authorizationEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        authorizationEntered = resolve;
      });
      let releaseAuthorization!: () => void;
      const heldAuthorization = new Promise<void>((resolve) => {
        releaseAuthorization = resolve;
      });
      let child!: Awaited<ReturnType<typeof launchUnconfinedProcess>>["child"];
      const executeTool = vi.fn(async () => ({ unexpected: true }));
      const run = request({
        tools: [{ name: "fixture_echo", description: "Echo", inputSchema: {} }],
        authorizeTool: async () => {
          authorizationEntered();
          await heldAuthorization;
          return undefined;
        },
        executeTool,
      });
      const finishSignal = turnFinishSignal(run.runId);
      const adapter = new HermesRuntime({
        command: process.execPath,
        args: [fixture, "pending-tool-malformed"],
        launch: async (spec) => {
          const result = await launchUnconfinedProcess(spec);
          child = result.child;
          return result;
        },
        onTurnFinished: finishSignal.onTurnFinished,
      });
      const controller = new AbortController();
      const events = adapter.run(run, { signal: controller.signal })[Symbol.asyncIterator]();
      try {
        expect((await events.next()).value).toEqual({
          type: "text",
          text: "before protocol failure.",
        });
        await entered;
        if (transition === "abort") await adapter.abort(run.runId);
        else if (transition === "signal") controller.abort();
        else if (transition === "bridge pause") {
          // The serialized bridge cannot begin a second call while authorization is held.
          // Its pause callback enters the same private terminal transition tested here.
          await (
            adapter as unknown as { finishTurn: (id: string, reason: "pause") => Promise<void> }
          ).finishTurn(run.runId, "pause");
        } else {
          const method = {
            end_turn: "fixture/finish-now",
            "forbidden tool": "fixture/forbidden-now",
            "protocol failure": "fixture/fail-now",
            "queue overflow": "fixture/overflow-now",
          }[transition];
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
        }
        const expectedReason = {
          end_turn: "done",
          "bridge pause": "pause",
          "forbidden tool": "failure",
          "protocol failure": "failure",
          "queue overflow": "failure",
          abort: "cancel",
          signal: "cancel",
        }[transition];
        expect(await finishSignal.finished).toBe(expectedReason);
        releaseAuthorization();
        try {
          while (!(await events.next()).done) {
            // Drain any events that preceded the terminal transition.
          }
        } catch {
          // Failure transitions carry their queue error to the consumer.
        }
        expect(executeTool).not.toHaveBeenCalled();
        expect(finishSignal.calls).toEqual([expectedReason]);
      } finally {
        releaseAuthorization();
        await events.return?.();
      }
    });
  }

  it("fences a pending tool when a paused consumer overflows its queue", async () => {
    let authorizationEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      authorizationEntered = resolve;
    });
    let releaseAuthorization!: () => void;
    const heldAuthorization = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let child!: Awaited<ReturnType<typeof launchUnconfinedProcess>>["child"];
    const executeTool = vi.fn(async () => ({ unexpected: true }));
    const run = request({
      tools: [{ name: "fixture_echo", description: "Echo", inputSchema: {} }],
      authorizeTool: async () => {
        authorizationEntered();
        await heldAuthorization;
        return undefined;
      },
      executeTool,
    });
    const finishSignal = turnFinishSignal(run.runId);
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "queue-overflow"],
      launch: async (spec) => {
        const result = await launchUnconfinedProcess(spec);
        child = result.child;
        return result;
      },
      onTurnFinished: finishSignal.onTurnFinished,
    });
    const events = adapter.run(run)[Symbol.asyncIterator]();
    try {
      expect(await events.next()).toEqual({
        value: { type: "text", text: "before protocol failure." },
        done: false,
      });
      await entered;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "fixture/overflow" })}\n`);
      expect(await finishSignal.finished).toBe("failure");
      releaseAuthorization();
      const drain = async () => {
        while (!(await events.next()).done) {
          // Buffered progress precedes the stored queue error.
        }
      };
      await expect(drain()).rejects.toMatchObject({
        message: "Hermes could not complete this turn.",
        cause: { message: expect.stringContaining("kind: output overflow") },
      });
      expect(executeTool).not.toHaveBeenCalled();
      expect(finishSignal.calls).toEqual(["failure"]);
    } finally {
      releaseAuthorization();
      await events.return?.();
    }
  });

  it("isolates the home, cwd and environment and writes a secret-free config", async () => {
    process.env.ARDUR_PARENT_SECRET = "fixture-parent-secret";
    try {
      const events = await collect(
        runtime("inspect"),
        request({ history: [{ role: "assistant", content: "Earlier answer" }] }),
      );
      const data = JSON.parse(
        events
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join(""),
      );
      expect(data).toMatchObject({
        homeMatches: true,
        cwdMatches: true,
        parentSecretAbsent: true,
        configHasKey: false,
      });
      expect(data.config.agent.reasoning_effort).toBe("high");
      expect(data.config.custom_providers[0].key_env).toBe("ARDUR_HERMES_PROVIDER_KEY");
      expect(data.context).toContain("Earlier answer");
      expect(data.prompt).toEqual([{ type: "text", text: "Hello" }]);
    } finally {
      delete process.env.ARDUR_PARENT_SECRET;
    }
  });

  it("redacts the provider key and relay capability across text chunks", async () => {
    const events = await collect(runtime("redact"), request());
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join("");
    expect(text).not.toContain("fixture-provider-key-123");
    expect(text).not.toMatch(/[a-f0-9]{64}/);
    expect(text.match(/\[redacted\]/g)).toHaveLength(2);
    expect(text).toContain("suffix");
  });

  for (const split of ["1", "63", "64", "three"]) {
    it(`redacts a relay capability split at ${split}`, async () => {
      const events = await collect(runtime("redact-boundaries"), request({ prompt: split }));
      const text = events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      expect(text).not.toMatch(/[a-f0-9]{64}/);
      expect(text.match(/\[redacted\]/g)).toHaveLength(2);
    });
  }

  for (const kind of ["provider", "relay"] as const) {
    it(`redacts ${kind} when a labelled value is split after its first character`, async () => {
      const events = await collect(runtime("redact-labelled-boundary"), request({ prompt: kind }));
      const text = events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      if (kind === "provider") {
        expect(text).not.toContain("fixture-provider-key-123");
        expect(text).not.toContain("ixture-provider-key-123");
      } else {
        expect(text).not.toMatch(/[a-f0-9]{63,64}/);
      }
      expect(text.match(/\[redacted\]/g)).toHaveLength(1);
      expect(text).toContain("suffix");
    });
  }

  it("redacts a complete secret whose last character starts another possible match", async () => {
    const run = request({ prompt: "provider" });
    run.model.apiKey = "fixture-provider-key-f";
    const events = await collect(runtime("redact-labelled-boundary"), run);
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join("");
    expect(text).toBe("Bearer [redacted] suffix");
  });

  for (const kind of ["provider", "relay"] as const) {
    it(`redacts a complete ${kind} secret before holding its repeated first character`, async () => {
      const run = request({ prompt: kind });
      if (kind === "provider") run.model.apiKey = "fixture-provider-key-f";
      const events = await collect(runtime("redact-overlap"), run);
      const text = events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      if (kind === "provider") expect(text).toBe("[redacted]i!");
      else {
        expect(text).toContain("[redacted]");
        expect(text.endsWith("!")).toBe(true);
      }
    });
  }

  it("redacts a secret followed by its own prefix across three chunks", async () => {
    const run = request();
    run.model.apiKey = "fixture-provider-key-f";
    const events = await collect(runtime("redact-overlap-three"), run);
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join("");
    expect(text).toBe("[redacted]i!");
  });

  it("protects self-overlapping relay-shaped spellings", () => {
    const relay = "f".repeat(64);
    const output: string[] = [];
    const emit = createHermesTextRedactor([relay], (text) => output.push(text));
    emit(`${relay}f`);
    emit("!");
    emit("", true);
    expect(output.join("")).toBe("[redacted]f!");
  });

  it("protects 200 short-alphabet keys at every two-chunk boundary", () => {
    let state = 0x51f15e;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let keyIndex = 0; keyIndex < 200; keyIndex++) {
      const length = 8 + (next() % 57);
      const key = Array.from({ length }, () => "abc"[next() % 3]).join("");
      for (const raw of [`${key}${key.slice(0, 2)}!`, `${key}|${key}`]) {
        const occurrences = raw.split(key).length - 1;
        for (let boundary = 1; boundary < raw.length; boundary++) {
          const output: string[] = [];
          const emit = createHermesTextRedactor([key], (text) => output.push(text));
          emit(raw.slice(0, boundary));
          emit(raw.slice(boundary));
          emit("", true);
          const joined = output.join("");
          expect(joined).not.toContain(key);
          expect(joined.match(/\[redacted\]/g)).toHaveLength(occurrences);
        }
      }
    }
  });

  it("reserves a run during launch and fences an abort before ACP starts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let launched!: () => void;
    const entered = new Promise<void>((resolve) => {
      launched = resolve;
    });
    const writes: string[] = [];
    const adapter = new HermesRuntime({
      command: process.execPath,
      launch: async (spec) => {
        launched();
        await gate;
        const child = spawn(spec.command, [fixture, "text"], {
          cwd: spec.cwd,
          env: spec.env,
          stdio: "pipe",
        });
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((value: string) => {
          writes.push(value);
          return write(value);
        }) as typeof child.stdin.write;
        return { child, teardown: async () => stopNative(child) };
      },
    });
    const run = request();
    const first = collect(adapter, run);
    await entered;
    const second = collect(adapter, run).then(
      () => "completed",
      (error: Error) => error.message,
    );
    await adapter.abort(run.runId);
    release();
    expect(await first).not.toContainEqual({ type: "done" });
    expect(await second).toBe("This Hermes run is already active.");
    expect(writes.some((line) => line.includes("session/prompt"))).toBe(false);
    expect(writes.some((line) => line.includes("session/new"))).toBe(false);
  });

  it("does not prompt after cancellation in onRuntimeInfo", async () => {
    const writes: string[] = [];
    const adapter = new HermesRuntime({
      command: process.execPath,
      launch: async (spec) => {
        const child = spawn(spec.command, [fixture, "text"], {
          cwd: spec.cwd,
          env: spec.env,
          stdio: "pipe",
        });
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((value: string) => {
          writes.push(value);
          return write(value);
        }) as typeof child.stdin.write;
        return { child, teardown: async () => stopNative(child) };
      },
    });
    const run = request();
    const controller = new AbortController();
    run.onRuntimeInfo = async () => {
      controller.abort();
      await Promise.resolve();
    };
    expect(await collect(adapter, run, controller.signal)).not.toContainEqual({ type: "done" });
    expect(writes.some((line) => line.includes("session/prompt"))).toBe(false);
  });

  it("does not turn an ACP default zero into measured output usage", async () => {
    const events = await collect(runtime("defaulted-usage"), request());
    expect(events.some((event) => event.type === "usage")).toBe(false);
  });

  it("cancels before an MCP call and fences later activity", async () => {
    let promptSent!: () => void;
    const prompted = new Promise<void>((resolve) => {
      promptSent = resolve;
    });
    const run = request({
      tools: [{ name: "fixture_echo", description: "Echo", inputSchema: {} }],
      executeTool: vi.fn(async () => ({ ok: true })),
    });
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "before-tool"],
      launch: async (spec) => {
        const result = await launchUnconfinedProcess(spec);
        const write = result.child.stdin.write.bind(result.child.stdin);
        result.child.stdin.write = ((value: string) => {
          const written = write(value);
          if (value.includes('"method":"session/prompt"')) promptSent();
          return written;
        }) as typeof result.child.stdin.write;
        return result;
      },
    });
    const events = collect(adapter, run);
    await Promise.race([
      prompted,
      events.then(() => {
        throw new Error("Hermes ended before sending its prompt.");
      }),
    ]);
    await adapter.abort(run.runId);
    expect(await events).not.toContainEqual({ type: "done" });
    expect(run.executeTool).not.toHaveBeenCalled();
  });

  it("fences event delivery while a tool is in progress", async () => {
    let entered!: () => void;
    const begun = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise((resolve) => {
      release = () => resolve({ ok: true });
    });
    const run = request({
      tools: [{ name: "fixture_echo", description: "Echo", inputSchema: {} }],
      executeTool: async () => {
        entered();
        return held;
      },
    });
    const adapter = runtime("during-tool");
    const events = collect(adapter, run);
    await begun;
    await adapter.abort(run.runId);
    release();
    expect(await events).not.toContainEqual({ type: "done" });
  });

  it("drops queued events after abort while the consumer is paused", async () => {
    const run = request();
    const finishSignal = turnFinishSignal(run.runId);
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "text"],
      launch: launchUnconfinedProcess,
      onTurnFinished: finishSignal.onTurnFinished,
    });
    const events = adapter.run(run)[Symbol.asyncIterator]();
    expect(await events.next()).toEqual({
      value: { type: "text", text: expect.stringMatching(/^first /) },
      done: false,
    });
    expect(await finishSignal.finished).toBe("done");
    await adapter.abort(run.runId);
    expect(await events.next()).toEqual({ value: undefined, done: true });
  });

  for (const rejects of [false, true]) {
    it(`awaits signal cancellation teardown when it ${rejects ? "rejects" : "resolves"}`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let teardownEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        teardownEntered = resolve;
      });
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      process.on("unhandledRejection", onUnhandled);
      const controller = new AbortController();
      const adapter = new HermesRuntime({
        command: process.execPath,
        args: [fixture, "text"],
        launch: async (spec) => {
          const result = await launchUnconfinedProcess(spec);
          return {
            ...result,
            teardown: async () => {
              teardownEntered();
              await gate;
              if (rejects) throw new Error("Fixture teardown failed.");
              await result.teardown();
            },
          };
        },
      });
      let settled = false;
      try {
        const collection = (async () => {
          for await (const event of adapter.run(request(), { signal: controller.signal })) {
            if (event.type === "text") controller.abort();
          }
        })().finally(() => {
          settled = true;
        });
        await entered;
        expect(settled).toBe(false);
        release();
        if (rejects) await expect(collection).rejects.toThrow("Fixture teardown failed.");
        else await expect(collection).resolves.toBeUndefined();
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        release();
        process.off("unhandledRejection", onUnhandled);
      }
    });
  }
});
