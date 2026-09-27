import { createHash } from "node:crypto";
import type { AgentRunRequest, AgentUsage } from "@ardurbot/adapter-kit";
import type { HostFrame, HostOperation } from "@ardurbot/contracts/host-bridge";
import type { HostClient } from "@ardurbot/host-runtime/host-client";
import { describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import type { BrokerScope, HermesProviderBroker } from "./hermes-provider-broker.js";
import { RemoteHostRuntime } from "./remote-host-runtime.js";
import { accountRuntimeUsage } from "./runtime-usage.js";

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
  it.each(["with ACP totals", "without ACP totals"])(
    "leaves Hermes provider accounting to the broker %s",
    async (scenario) => {
      const generation = crypto.randomUUID();
      const grant = {
        id: crypto.randomUUID(),
        token: "a".repeat(43),
        expiresAt: Date.now() + 60_000,
      };
      const broker = { grant, revoke: vi.fn(), open: vi.fn() } as unknown as HermesProviderBroker;
      const client = {
        health: async () => ({ capabilities: { providerRelay: 1 }, generation }),
        request: async function* (
          _operation: HostOperation,
          _context: unknown,
          _callback: Callback,
          operationId: string,
        ) {
          if (scenario === "with ACP totals")
            yield {
              v: 1,
              type: "stream",
              id: operationId,
              seq: 0,
              channel: "event",
              data: {
                type: "usage",
                provider: "fixture",
                model: "fixture-model",
                inputTokens: 30,
                outputTokens: 7,
              },
            };
          yield {
            v: 1,
            type: "stream",
            id: operationId,
            seq: 1,
            channel: "event",
            data: { type: "done" },
          };
        },
      } as unknown as HostClient;
      const remote = new RemoteHostRuntime(client, "hermes", async (_run, _context, fence) => {
        const scope: BrokerScope = {
          runId: "run",
          botId: "bot",
          userId: "owner",
          spaceId: "space",
          operationId: fence.operationId,
          leaseOwner: "worker",
          leaseFence: 1,
          hostGeneration: createHash("sha256")
            .update(fence.hostGeneration)
            .digest()
            .readUIntBE(0, 6),
          configurationHash: "fixture",
          pin: {
            credentialId: "credential",
            provider: "fixture",
            modelId: "fixture-model",
            effort: "high",
          },
        };
        return { broker, scope };
      });
      const base = request();
      const run: AgentRunRequest = {
        ...base,
        model: {
          ...base.model,
          provider: "fixture",
          id: "fixture-model",
          thinkingLevel: "high",
          runtimePin: {
            runtimeKind: "hermes",
            provider: "fixture",
            modelId: "fixture-model",
            effort: "high",
            credentialId: "credential",
            revision: 1,
          } as unknown as AgentRunRequest["model"]["runtimePin"],
        },
      };
      const record = vi.fn(async (_usage: AgentUsage) => undefined);
      const observed = accountRuntimeUsage(remote.run(run, { userId: "owner", spaceId: "space" }), {
        provider: "fixture",
        model: "fixture-model",
        accounting: remote.describe().capabilities.usageAccounting,
        record,
      });
      const events = [];
      for await (const event of observed) events.push(event);
      expect(events).toEqual([{ type: "done" }]);
      expect(record).not.toHaveBeenCalled();
      expect(broker.revoke).toHaveBeenCalledOnce();
    },
  );
  it.each(["claude-code", "codex-app-server", "antigravity"] as const)(
    "keeps runtime accounting for %s",
    async (kind) => {
      const remote = new RemoteHostRuntime({} as HostClient, kind);
      expect(remote.describe().capabilities).not.toHaveProperty("usageAccounting");
      const record = vi.fn(async (_usage: AgentUsage) => undefined);
      const events = accountRuntimeUsage(
        (async function* () {
          yield {
            type: "usage",
            provider: "fixture",
            model: "fixture-model",
            inputTokens: 30,
            outputTokens: 7,
          } as const;
          yield { type: "done" } as const;
        })(),
        {
          provider: "fixture",
          model: "fixture-model",
          accounting: remote.describe().capabilities.usageAccounting,
          record,
        },
      );
      for await (const _ of events) {
        // The terminal event completes accounting.
      }
      expect(record).toHaveBeenCalledTimes(2);
      expect(record.mock.calls[0]?.[0]).toMatchObject({
        inputTokens: 30,
        outputTokens: 7,
      });
    },
  );
  it("refuses an older host before creating a broker grant", async () => {
    const broker = vi.fn();
    const client = {
      health: vi.fn(async () => ({ platform: "linux", roots: [], load: 0 })),
    } as unknown as HostClient;
    const remote = new RemoteHostRuntime(client, "hermes", broker);
    await expect(collect(remote.run(request()))).rejects.toThrow("pinned provider relay");
    expect(broker).not.toHaveBeenCalled();
  });
  it("binds provider callbacks to the negotiated host operation without a provider key", async () => {
    const generation = crypto.randomUUID();
    const grant = {
      id: crypto.randomUUID(),
      token: "a".repeat(43),
      expiresAt: Date.now() + 60_000,
    };
    const revoke = vi.fn();
    const open = vi.fn(
      async () =>
        new Response('{"model":"fixture-model"}', {
          headers: { "content-type": "application/json" },
        }),
    );
    const broker = { grant, revoke, open } as unknown as HermesProviderBroker;
    let expectedOperationId = "";
    const client = {
      health: async () => ({ capabilities: { providerRelay: 1 }, generation }),
      request: async function* (
        operation: HostOperation,
        _context: unknown,
        callback: Callback,
        operationId: string,
      ) {
        expect(operation.op).toBe("runtime.turn");
        if (operation.op !== "runtime.turn") throw new Error("Wrong operation");
        expect(operationId).toBe(expectedOperationId);
        expect(operation.request.providerBroker).toMatchObject({
          protocol: 1,
          id: grant.id,
          hostGeneration: generation,
        });
        expect(JSON.stringify(operation)).not.toContain("real-provider-key");
        await expect(callback(frame("provider.read", [0]))).rejects.toThrow("sequence");
        expect(await callback(frame("provider.open", [{ model: "fixture-model" }]))).toEqual({
          status: 200,
          contentType: "application/json",
        });
        expect(await callback(frame("provider.read", [0]))).toEqual({
          seq: 0,
          chunk: Buffer.from('{"model":"fixture-model"}').toString("base64"),
          done: true,
        });
        yield {
          v: 1,
          type: "stream",
          id: operationId,
          seq: 0,
          channel: "event",
          data: { type: "done" },
        } as const;
      },
    } as unknown as HostClient;
    const remote = new RemoteHostRuntime(client, "hermes", async (_request, _context, fence) => {
      expectedOperationId = fence.operationId;
      const scope: BrokerScope = {
        runId: "run",
        botId: "bot",
        userId: "owner",
        spaceId: "space",
        operationId: fence.operationId,
        leaseOwner: "worker",
        leaseFence: 1,
        hostGeneration: createHash("sha256").update(fence.hostGeneration).digest().readUIntBE(0, 6),
        configurationHash: "fixture",
        pin: {
          credentialId: "credential",
          provider: "fixture",
          modelId: "fixture-model",
          effort: "high",
        },
      };
      return { broker, scope };
    });
    const original = request();
    const run: AgentRunRequest = {
      ...original,
      model: {
        ...original.model,
        provider: "fixture",
        id: "fixture-model",
        thinkingLevel: "high",
        contextWindow: 65_536,
        maxTokens: 1024,
        runtimePin: {
          runtimeKind: "hermes",
          provider: "fixture",
          modelId: "fixture-model",
          effort: "high",
          credentialId: "credential",
          revision: 1,
        } as unknown as AgentRunRequest["model"]["runtimePin"],
      },
    };
    expect(await collect(remote.run(run, { userId: "owner", spaceId: "space" }))).toEqual([
      { type: "done" },
    ]);
    expect(open).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
  });
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
