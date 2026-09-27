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
    expect(args).not.toContain("--input-format");
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
