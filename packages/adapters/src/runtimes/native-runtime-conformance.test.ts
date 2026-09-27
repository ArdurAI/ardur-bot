import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import type { RuntimeKind, RuntimePin } from "@ardurbot/contracts";
import { AntigravityStreamParser } from "@ardurbot/host-runtime/runtimes/antigravity-stream";
import { CodexUsageCollector } from "@ardurbot/host-runtime/runtimes/codex-usage";
import { describe, expect, it, vi } from "vitest";
import { RuntimeRegistry } from "../runtime-registry.js";
import { AntigravityRuntime, antigravityArguments } from "./antigravity-runtime.js";
import { ClaudeCodeRuntime, ClaudeStreamParser, claudeArguments } from "./claude-code-runtime.js";
import { CodexAppServerRuntime, codexArguments } from "./codex-app-server-runtime.js";
import { nativeEnvironment, stopNative } from "./native-process.js";

const entries = [
  ["claude-code", new ClaudeCodeRuntime(), "anthropic", "claude-opus-5", "low"],
  ["codex-app-server", new CodexAppServerRuntime(), "openai-codex", "model", "high"],
  ["antigravity", new AntigravityRuntime(), "antigravity", "gemini-3.8-flash-low", "low"],
] as const;

describe.each(entries)(
  "native runtime conformance: %s",
  (kind, runtime: AgentRuntime, provider, modelId, effort) => {
    const pin: RuntimePin = {
      runtimeKind: kind as RuntimeKind,
      provider,
      modelId,
      effort,
      credentialId: `native:${kind}`,
      revision: 1,
    };
    const registry = new RuntimeRegistry({
      [kind]: {
        factory: () => runtime,
        probe: async () => ({
          runtimeKind: kind,
          available: true,
          models: [{ id: modelId, label: modelId, efforts: [effort] }],
        }),
      },
    });
    it("refuses unsupported computers without probing or changing the pin", async () => {
      const before = structuredClone(pin);
      expect(await registry.resolve(pin, "docker", true)).toMatchObject({
        code: "runtime-unsupported-computer",
        pin: before,
      });
      expect(pin).toEqual(before);
    });
    it("never forwards a hosted key through the native environment", () => {
      expect(
        nativeEnvironment({
          PATH: "/bin",
          HOME: "/tmp/fake-home",
          ANTHROPIC_API_KEY: "fake-secret",
          OPENAI_API_KEY: "fake-secret",
          BOT_SECRET: "fake-secret",
        }),
      ).toEqual({ PATH: "/bin", HOME: "/tmp/fake-home" });
      expect(runtime.describe().id).toBe(kind);
      const request: AgentRunRequest = {
        botId: "bot",
        threadId: "thread",
        runId: "run",
        prompt: "Hello",
        instructions: "Do the task",
        history: [],
        tools: "none",
        model: { provider, id: modelId, runtimePin: pin },
      };
      const args =
        kind === "claude-code"
          ? claudeArguments(request, { command: "node", args: [] }, "session")
          : kind === "codex-app-server"
            ? codexArguments()
            : antigravityArguments(request);
      expect(args.join(" ")).not.toContain("fake-secret");
    });
    it("does not silently select an unknown model", async () => {
      expect(await registry.resolve({ ...pin, modelId: "unknown" }, "desktop", true)).toMatchObject(
        { code: "pin-model-unknown" },
      );
    });
    it("keeps missing usage unknown rather than inventing zero or a price", () => {
      let receipt: AgentRuntimeEvent | undefined;
      if (kind === "claude-code") {
        const parser = new ClaudeStreamParser(pin);
        parser.parse({ type: "system", subtype: "init", model: modelId, tools: [] });
        receipt = parser
          .parse({ type: "result", subtype: "success", modelUsage: { [modelId]: {} } })
          .find((event) => event.type === "usage");
      } else if (kind === "codex-app-server") {
        const usage = new CodexUsageCollector(provider, modelId, false);
        usage.start();
        receipt = usage.finish("success");
      } else {
        const parser = new AntigravityStreamParser(pin);
        parser.parse({ event: "init", init: { model: modelId } });
        parser.parse({
          event: "step_update",
          step_update: { step_type: "agent_response", text_delta: "Hi" },
        });
        parser.parse({ event: "result", result: { status: "SUCCESS", response: "Hi" } });
        receipt = parser.finishUsage("success")[0];
      }
      expect(receipt).toMatchObject({
        type: "usage",
        reported: false,
        request: {
          cost: null,
          categories: { logicalInput: null, output: null, reasoning: null, cacheReadInput: null },
          collection: { availability: "unavailable" },
        },
      });
    });
    it.skipIf(process.platform === "win32")("stops the shared native process group", async () => {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      Object.assign(child, {
        pid: 12345,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(),
      });
      const signal = vi.spyOn(process, "kill").mockImplementation((pid, name) => {
        if (pid === -12345) {
          Object.assign(child, { signalCode: name });
          queueMicrotask(() => child.emit("close", 0));
        }
        return true;
      });
      try {
        await stopNative(child);
        expect(signal).toHaveBeenCalledWith(-12345, "SIGTERM");
        expect(child.kill).not.toHaveBeenCalled();
      } finally {
        signal.mockRestore();
      }
    });
  },
);
