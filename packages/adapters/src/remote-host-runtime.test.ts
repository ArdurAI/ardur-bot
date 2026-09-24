import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import type { HostFrame, HostOperation } from "@ardurbot/contracts/host-bridge";
import type { HostClient } from "@ardurbot/host-runtime/host-client";
import { describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import { RemoteHostRuntime } from "./remote-host-runtime.js";

const request = (): AgentRunRequest => ({
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "hello",
  instructions: "",
  history: [],
  nativeCwd: "host:computer",
  model: {
    provider: "anthropic",
    id: "claude-opus-4-6",
    thinkingLevel: "low",
    runtimePin: {
      runtimeKind: "claude-code",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      effort: "low",
      revision: 1,
      credentialId: "credential",
    },
  },
  tools: [
    {
      name: "write_file",
      description: "Write",
      inputSchema: { type: "object" },
      route: { connectorId: "connector", toolName: "write" },
    },
  ],
});
type Callback = NonNullable<Parameters<HostClient["request"]>[2]>;
function frame(method: Extract<HostFrame, { type: "callback" }>["method"], args: unknown[]) {
  return { v: 1, type: "callback", id: "request", callId: "call", method, args } as const;
}
function runtime(invoke: (callback: Callback, operation: HostOperation) => Promise<void>) {
  return new RemoteHostRuntime(
    {
      request: async function* (operation: HostOperation, _context: unknown, callback: Callback) {
        await invoke(callback, operation);
        yield {
          v: 1,
          type: "stream",
          id: "request",
          seq: 0,
          channel: "event",
          data: { type: "done" },
        };
      },
    } as unknown as HostClient,
    "claude-code",
  );
}
async function collect(source: ReturnType<RemoteHostRuntime["run"]>) {
  const events = [];
  for await (const event of source) events.push(event);
  return events;
}
describe("worker-owned remote runtime callbacks", () => {
  it("retains effort evidence across the host callback schema", async () => {
    const onRuntimeInfo = vi.fn();
    const info = {
      runtimeKind: "claude-code",
      sessionId: "session",
      effortAttested: false,
      effortAttestationReason: "Claude Code does not report the applied effort",
    };
    const remote = runtime(async (callback) => {
      await callback(frame("onRuntimeInfo", [info]));
    });
    await collect(remote.run({ ...request(), onRuntimeInfo }));
    expect(onRuntimeInfo).toHaveBeenCalledWith(info);
  });
  it("keeps routes private, records the local result, and refuses a replay after completion", async () => {
    const executeTool = vi.fn(async () => ({ ok: true })),
      onToolCompleted = vi.fn();
    const remote = runtime(async (callback, operation) => {
      expect(operation).toMatchObject({ op: "runtime.turn", homeKey: "computer" });
      expect(JSON.stringify(operation)).not.toContain("connectorId");
      await callback(frame("executeTool", ["write_file", { path: "file" }, "run:execution"]));
      await callback(
        frame("onToolCompleted", [
          {
            name: "write_file",
            executionId: "run:execution",
            durationMs: 1,
            result: "untrusted host value",
          },
        ]),
      );
      await expect(
        callback(frame("executeTool", ["write_file", {}, "run:execution"])),
      ).rejects.toThrow("Invalid");
      await expect(callback(frame("executeTool", ["unknown", {}, "run:second"]))).rejects.toThrow(
        "unavailable",
      );
    });
    await collect(remote.run({ ...request(), executeTool, onToolCompleted }));
    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledWith("write_file", { path: "file" }, "run:execution", {
      connectorId: "connector",
      toolName: "write",
    });
    expect(onToolCompleted).toHaveBeenCalledWith(expect.objectContaining({ result: { ok: true } }));
  });
  it("records an approval pause that never reaches executeTool", async () => {
    const paused = approvalPausedToolResult(),
      executeTool = vi.fn(),
      onToolCompleted = vi.fn();
    const remote = runtime(async (callback) => {
      expect(await callback(frame("authorizeTool", ["write_file"]))).toEqual(paused);
      await callback(
        frame("onToolCompleted", [
          { name: "write_file", executionId: "run:pause", paused: true, durationMs: 2 },
        ]),
      );
    });
    await collect(
      remote.run({ ...request(), authorizeTool: async () => paused, executeTool, onToolCompleted }),
    );
    expect(executeTool).not.toHaveBeenCalled();
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ paused: true, result: paused }),
    );
  });
  it("refuses credential material before opening a host request", async () => {
    const invoke = vi.fn();
    const turn = request();
    turn.model.apiKey = "fixture-secret";
    await expect(collect(runtime(invoke).run(turn))).rejects.toThrow("own sign-in");
    expect(invoke).not.toHaveBeenCalled();
  });
});
