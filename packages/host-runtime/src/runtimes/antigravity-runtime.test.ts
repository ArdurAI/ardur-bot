import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  AntigravityRuntime,
  antigravityArguments,
  probeAntigravity,
} from "./antigravity-runtime.js";
import type { NativeSpawn } from "./native-process.js";

const script = fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url));
function fixture(prompt = "success", deadlineMs?: number) {
  const calls: string[][] = [];
  const start: NativeSpawn = (_binary, args, cwd) => {
    calls.push(args);
    return spawn(process.execPath, [script, ...args], {
      cwd,
      stdio: "pipe",
    }) as ChildProcessWithoutNullStreams;
  };
  const request: AgentRunRequest = {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt,
    instructions: "Do the task",
    nativeCwd: "/tmp",
    history: [],
    tools: "none",
    model: {
      provider: "antigravity",
      id: "gemini-3.8-flash-low",
      runtimePin: {
        runtimeKind: "antigravity",
        provider: "antigravity",
        modelId: "gemini-3.8-flash-low",
        effort: "low",
        credentialId: "native:antigravity",
        revision: 1,
      },
    },
  };
  const resolveBinary = async () => "/fake/agy";
  const runtime = new AntigravityRuntime(start, resolveBinary, deadlineMs);
  const collect = async () => {
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(request)) events.push(event);
    return events;
  };
  return { calls, start, resolveBinary, request, runtime, collect };
}
describe("Antigravity fake process", () => {
  it("probes without a model turn and keeps sign-in unknown", async () => {
    const f = fixture();
    const status = await probeAntigravity(f.start, f.resolveBinary);
    expect(status).toMatchObject({ available: true, signInStatus: "unknown", version: "1.2.12" });
    expect(f.calls.map((args) => args[0])).toEqual(["--version", "--help", "models"]);
  });
  it("streams a text turn with exact model, effort, reported usage and no secrets", async () => {
    const f = fixture();
    const events = await f.collect();
    expect(events).toContainEqual({ type: "text", text: "Hello" });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(
      events.find(
        (event) => event.type === "usage" && event.request?.collection?.outcome === "success",
      ),
    ).toMatchObject({ inputTokens: 10, outputTokens: 2, request: { cost: null } });
    const args = f.calls.at(-1)!;
    expect(args).toContain("--model");
    expect(args).toContain("--effort");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("--input-format");
    expect(args).toContain("--print=");
    expect(args.join(" ")).not.toContain("Do the task");
  });
  it("sends content above 200,000 bytes without putting it in argv", async () => {
    const f = fixture("你".repeat(70_000));
    expect(Buffer.byteLength(f.request.prompt)).toBeGreaterThanOrEqual(200_000);
    expect((await f.collect()).at(-1)).toEqual({ type: "done" });
    expect(f.calls.at(-1)?.join(" ")).not.toContain("你");
  });
  it("bounds the stdin event before spawning", async () => {
    const f = fixture("x".repeat(2 * 1024 * 1024));
    await expect(f.collect()).rejects.toMatchObject({
      problem: { code: "runtime-unavailable", reasonId: "input-too-large" },
    });
    expect(f.calls.some((args) => args[0] === "--print=")).toBe(false);
  });
  it("surfaces a stdin write error as runtime-unavailable", async () => {
    const f = fixture();
    const start: NativeSpawn = (binary, args, cwd) => {
      const child = f.start(binary, args, cwd);
      if (args[0] === "--print=") child.stdin.destroy(new Error("fake write failure"));
      return child;
    };
    const runtime = new AntigravityRuntime(start, f.resolveBinary);
    const collect = async () => {
      for await (const _event of runtime.run(f.request)) {
        /* consume */
      }
    };
    await expect(collect()).rejects.toMatchObject({
      problem: { code: "runtime-unavailable", reasonId: "input-write-failed" },
    });
  });
  it("keeps a closed child's stdin error inside the failed turn", async () => {
    const f = fixture("x".repeat(1024 * 1024));
    const start: NativeSpawn = (binary, args, cwd) =>
      args[0] === "--print="
        ? (spawn(process.execPath, ["-e", "process.exit(0)"], {
            cwd,
            stdio: "pipe",
          }) as ChildProcessWithoutNullStreams)
        : f.start(binary, args, cwd);
    const runtime = new AntigravityRuntime(start, f.resolveBinary);
    let uncaught: Error | undefined;
    const onUncaught = (error: Error) => {
      uncaught = error;
    };
    process.once("uncaughtException", onUncaught);
    try {
      const collect = async () => {
        for await (const _event of runtime.run(f.request)) {
          /* consume */
        }
      };
      await expect(collect()).rejects.toMatchObject({
        problem: { code: "runtime-unavailable", reasonId: "input-write-failed" },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(uncaught).toBeUndefined();
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
  it("kills a child that blocks stdin past the watchdog deadline", async () => {
    const f = fixture("x".repeat(1024 * 1024));
    let turnChild: ChildProcessWithoutNullStreams | undefined;
    const start: NativeSpawn = (binary, args, cwd) => {
      if (args[0] !== "--print=") return f.start(binary, args, cwd);
      turnChild = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        { cwd, stdio: "pipe" },
      ) as ChildProcessWithoutNullStreams;
      return turnChild;
    };
    const runtime = new AntigravityRuntime(start, f.resolveBinary, 400);
    const safetyKill = setTimeout(() => turnChild?.kill("SIGKILL"), 4_000);
    const startedAt = Date.now();
    try {
      const collect = async () => {
        for await (const _event of runtime.run(f.request)) {
          /* consume */
        }
      };
      await expect(collect()).rejects.toMatchObject({
        problem: { code: "runtime-unavailable", reasonId: "timeout" },
      });
      expect(Date.now() - startedAt).toBeLessThan(2_500);
      if (process.platform === "win32") expect(turnChild?.exitCode).not.toBeNull();
      else expect(turnChild?.signalCode).toBe("SIGKILL");
    } finally {
      clearTimeout(safetyKill);
      if (turnChild?.exitCode === null && turnChild.signalCode === null) turnChild.kill("SIGKILL");
    }
  });
  it.each([
    ['{"event":"user"}\n', 'missing the "message" field'],
    ['{"event":"user","message":{"role":"user"}}\n', "has no content"],
    ['{"event":"user","message":"bare string"}\n', "could not decode"],
  ])("rejects malformed stdin events", async (input, expected) => {
    const child = spawn(
      process.execPath,
      [script, "--print=", "--input-format", "stream-json", "--output-format", "stream-json"],
      { stdio: "pipe" },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.end(input);
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(1);
    expect(stderr).toContain(expected);
  });
  it.each(["denied-tool", "model-error", "malformed", "premature", "nonzero", "mismatch"])(
    "fails closed for %s",
    async (scenario) => {
      const f = fixture(scenario);
      await expect(f.collect()).rejects.toMatchObject({
        problem: {
          code:
            scenario === "model-error" || scenario === "mismatch"
              ? "pin-model-unknown"
              : "runtime-unavailable",
        },
      });
    },
  );
  it("refuses secrets, images, tools and comparisons before spawning", async () => {
    for (const mutation of [
      (r: AgentRunRequest) => {
        r.model.apiKey = "fake-secret";
      },
      (r: AgentRunRequest) => {
        r.currentTurnImages = [{ name: "test", mimeType: "image/png", data: Buffer.from("fake") }];
      },
      (r: AgentRunRequest) => {
        r.tools = [
          {
            name: "fake",
            description: "fake",
            inputSchema: {},
            route: { kind: "builtin" },
          } as never,
        ];
      },
      (r: AgentRunRequest) => {
        r.controlledComparison = true;
      },
    ]) {
      const f = fixture();
      mutation(f.request);
      await expect(f.collect()).rejects.toMatchObject({
        problem: { pin: f.request.model.runtimePin },
      });
      expect(f.calls).toEqual([]);
    }
  });
  it("derives suffix effort for an unset pin and omits it for no-effort models", () => {
    const f = fixture();
    f.request.model.runtimePin!.effort = null;
    expect(antigravityArguments(f.request)).toContain("low");
    f.request.model.runtimePin!.modelId = "claude-sonnet-4-6";
    expect(antigravityArguments(f.request)).not.toContain("--effort");
  });
  it("stops a slow turn at the watchdog deadline", async () => {
    const f = fixture("slow", 10);
    await expect(f.collect()).rejects.toMatchObject({ problem: { code: "runtime-unavailable" } });
  });
  it("retries immediately after cached sign-out and records success", async () => {
    const f = fixture("auth-error");
    await expect(f.collect()).rejects.toMatchObject({ problem: { reasonId: "signed-out" } });
    expect((await probeAntigravity(f.start, f.resolveBinary)).signInStatus).toBe("signed-out");
    f.request.prompt = "success";
    expect((await f.collect()).at(-1)).toEqual({ type: "done" });
    expect((await probeAntigravity(f.start, f.resolveBinary)).signInStatus).toBe("signed-in");
  });
  it("clears cached sign-out on an explicit availability refresh", async () => {
    const f = fixture("success");
    expect((await f.collect()).at(-1)).toEqual({ type: "done" });
    f.request.prompt = "auth-error";
    await expect(f.collect()).rejects.toMatchObject({ problem: { reasonId: "signed-out" } });
    expect((await probeAntigravity(f.start, f.resolveBinary)).signInStatus).toBe("signed-out");
    const runsBeforeRefresh = f.calls.filter((args) => args[0] === "--print=").length;
    const refreshed = await probeAntigravity(f.start, f.resolveBinary, true);
    expect(refreshed.signInStatus).toBe("unknown");
    expect(refreshed.signedIn).toBeUndefined();
    expect(f.calls.filter((args) => args[0] === "--print=")).toHaveLength(runsBeforeRefresh);
  });
  it("cancels a turn after streamed text without reporting completion", async () => {
    const f = fixture("slow");
    const events: AgentRuntimeEvent[] = [];
    for await (const event of f.runtime.run(f.request)) {
      events.push(event);
      if (event.type === "text") await f.runtime.abort(f.request.runId);
    }
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
});
