import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  createHermesTextRedactor,
  HermesRuntime,
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

describe("HermesRuntime M0 ACP seam", () => {
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

  for (const [scenario, cause] of [
    ["malformed", "ACP sent malformed JSON."],
    ["oversize", "ACP line exceeded its size limit."],
    ["exit", "ACP closed before the turn completed."],
    ["poison-text", "ACP update handler failed."],
    ["non-object-content", "ACP update handler failed."],
  ] as const) {
    it(`ends cleanly when the agent sends ${scenario}`, async () => {
      await expect(collect(runtime(scenario), request())).rejects.toMatchObject({
        message: "Hermes could not complete this turn.",
        cause: { message: cause },
      });
    });
  }

  it("fences an authorized tool immediately when ACP fails while the consumer is paused", async () => {
    let authorizationEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      authorizationEntered = resolve;
    });
    let releaseAuthorization!: () => void;
    const heldAuthorization = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let malformedSeen!: () => void;
    const malformed = new Promise<void>((resolve) => {
      malformedSeen = resolve;
    });
    let child!: Awaited<ReturnType<typeof launchUnconfinedProcess>>["child"];
    const executeTool = vi.fn(async () => ({ unexpected: true }));
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "pending-tool-malformed"],
      launch: async (spec) => {
        const result = await launchUnconfinedProcess(spec);
        child = result.child;
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("{broken\n")) malformedSeen();
        });
        return result;
      },
    });
    const run = request({
      tools: [{ name: "fixture_echo", description: "Echo", inputSchema: {} }],
      authorizeTool: async () => {
        authorizationEntered();
        await heldAuthorization;
        return undefined;
      },
      executeTool,
    });
    const events = adapter.run(run)[Symbol.asyncIterator]();
    try {
      expect(await events.next()).toEqual({
        value: { type: "text", text: "before protocol failure." },
        done: false,
      });
      await entered;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "fixture/fail-now" })}\n`);
      await malformed;
      await new Promise((resolve) => setImmediate(resolve));
      releaseAuthorization();
      const drain = async () => {
        while (!(await events.next()).done) {
          // Buffered progress may precede the stored protocol error.
        }
      };
      await expect(drain()).rejects.toMatchObject({
        message: "Hermes could not complete this turn.",
        cause: { message: "ACP sent malformed JSON." },
      });
      expect(executeTool).not.toHaveBeenCalled();
    } finally {
      releaseAuthorization();
      await events.return?.();
    }
  });

  it("fences a pending tool when a paused consumer overflows its queue", async () => {
    let authorizationEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      authorizationEntered = resolve;
    });
    let releaseAuthorization!: () => void;
    const heldAuthorization = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let overflowWritten!: () => void;
    const written = new Promise<void>((resolve) => {
      overflowWritten = resolve;
    });
    let child!: Awaited<ReturnType<typeof launchUnconfinedProcess>>["child"];
    const executeTool = vi.fn(async () => ({ unexpected: true }));
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "queue-overflow"],
      launch: async (spec) => {
        const result = await launchUnconfinedProcess(spec);
        child = result.child;
        child.stderr.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("overflow-complete")) overflowWritten();
        });
        return result;
      },
    });
    const run = request({
      tools: [{ name: "fixture_echo", description: "Echo", inputSchema: {} }],
      authorizeTool: async () => {
        authorizationEntered();
        await heldAuthorization;
        return undefined;
      },
      executeTool,
    });
    const events = adapter.run(run)[Symbol.asyncIterator]();
    try {
      expect(await events.next()).toEqual({
        value: { type: "text", text: "before protocol failure." },
        done: false,
      });
      await entered;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "fixture/overflow" })}\n`);
      await written;
      await new Promise((resolve) => setImmediate(resolve));
      releaseAuthorization();
      const drain = async () => {
        while (!(await events.next()).done) {
          // Buffered progress precedes the stored queue error.
        }
      };
      await expect(drain()).rejects.toMatchObject({
        message: "Hermes could not complete this turn.",
        cause: { message: "Runtime output exceeded its limit." },
      });
      expect(executeTool).not.toHaveBeenCalled();
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
    const run = request({
      tools: [{ name: "fixture_echo", description: "Echo", inputSchema: {} }],
      executeTool: vi.fn(async () => ({ ok: true })),
    });
    const adapter = runtime("before-tool");
    const events = collect(adapter, run);
    await new Promise((resolve) => setTimeout(resolve, 90));
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

  it("drops buffered text and completion after abort while the consumer is paused", async () => {
    let promptCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      promptCompleted = resolve;
    });
    const adapter = new HermesRuntime({
      command: process.execPath,
      args: [fixture, "text"],
      launch: async (spec) => {
        const result = await launchUnconfinedProcess(spec);
        let output = "";
        result.child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes('"stopReason":"end_turn"')) promptCompleted();
        });
        return result;
      },
    });
    const run = request();
    const events = adapter.run(run)[Symbol.asyncIterator]();
    expect(await events.next()).toEqual({ value: { type: "text", text: "first " }, done: false });
    await completed;
    // Let the prompt response enqueue done while the consumer is still paused.
    await new Promise((resolve) => setImmediate(resolve));
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
