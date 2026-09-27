import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { HermesRuntime } from "./hermes-runtime.js";
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
    onPermissionAttempt,
  });
}

describe("HermesRuntime M0 ACP seam", () => {
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
  ] as const) {
    it(`ends cleanly when the agent sends ${scenario}`, async () => {
      await expect(collect(runtime(scenario), request())).rejects.toMatchObject({
        message: "Hermes could not complete this turn.",
        cause: { message: cause },
      });
    });
  }

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
});
