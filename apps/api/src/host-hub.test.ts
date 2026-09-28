import { createHash } from "node:crypto";
import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import type { HostFrame, HostRequest } from "@ardurbot/contracts/host-bridge";
import { HOST_IN_FLIGHT, HOST_WINDOW } from "@ardurbot/contracts/host-bridge";
import type { HostWire } from "@ardurbot/host-runtime/bridge-wire";
import type { HostClient } from "@ardurbot/host-runtime/host-client";
import { describe, expect, it, vi } from "vitest";
import type {
  BrokerScope,
  HermesProviderBroker,
} from "../../../packages/adapters/src/hermes-provider-broker.js";
import { RemoteHostRuntime } from "../../../packages/adapters/src/remote-host-runtime.js";
import { HostHub } from "./host-hub.js";

const request: HostRequest = {
  v: 1,
  type: "request",
  id: "request",
  scope: { userId: "owner", spaceId: "space", botId: "bot", runId: "run" },
  operation: { op: "computer.exec", homeKey: "bot", argv: ["echo", "ok"] },
};
const probe = (id: string): HostRequest => ({
  ...request,
  id,
  scope: { ...request.scope, runId: id },
  operation: { op: "computer.remote.discover" },
});
function wire() {
  const frames: HostFrame[] = [];
  return {
    frames,
    send: vi.fn(async (frame: HostFrame) => {
      frames.push(frame);
    }),
    close: vi.fn(),
  } satisfies HostWire & { frames: HostFrame[] };
}

function hermesRequest(hostGeneration: string, runId = "run"): HostRequest {
  return {
    ...request,
    scope: { ...request.scope, runId },
    operation: {
      op: "runtime.turn",
      homeKey: "bot",
      request: {
        botId: "bot",
        runId,
        threadId: "thread",
        prompt: "hi",
        instructions: "",
        history: [],
        tools: "none",
        model: {
          runtimePin: {
            runtimeKind: "hermes",
            provider: "fixture",
            modelId: "fixture-model",
            effort: "high",
            credentialId: "fixture",
            revision: 1,
          },
          provider: "fixture",
          id: "fixture-model",
          thinkingLevel: "high",
        },
        providerBroker: {
          protocol: 1,
          id: crypto.randomUUID(),
          token: "a".repeat(43),
          expiresAt: Date.now() + 60_000,
          hostGeneration,
        },
      },
    },
  };
}
function healthFrame(): HostFrame {
  return {
    v: 1,
    type: "health",
    health: {
      platform: "linux",
      roots: [],
      load: 0,
      claude: { runtimeKind: "claude-code", available: false, models: [] },
      codex: { runtimeKind: "codex-app-server", available: false, models: [] },
      capabilities: { providerRelay: 1 },
    },
  };
}

describe("outbound host hub", () => {
  it("accepts an older host's health and forwards an ordinary operation", async () => {
    const hub = new HostHub(async () => true);
    const host = wire();
    const worker = wire();
    hub.attach(host, "owner", "first");
    const oldHealth = healthFrame();
    if (oldHealth.type !== "health") throw new Error("Invalid fixture.");
    delete oldHealth.health.capabilities;
    await hub.fromHost(host, oldHealth);
    expect(hub.health?.capabilities).toBeUndefined();
    await hub.request(request, worker);
    expect(host.frames).toEqual([request]);
    hub.detach();
  });
  it("keeps Hermes on a negotiated host and fences provider callbacks to its worker", async () => {
    const hub = new HostHub(async () => true),
      host = wire(),
      worker = wire(),
      other = wire();
    hub.attach(host, "owner", "first");
    const hermes = hermesRequest(crypto.randomUUID());
    await hub.request(hermes, worker);
    expect(host.frames).toEqual([]);
    await hub.fromHost(host, healthFrame());
    const currentGeneration = hub.health!.generation!;
    const current = hermesRequest(currentGeneration);
    await hub.request({ ...current, id: "second" }, worker);
    expect(host.frames).toHaveLength(1);
    const callback = {
      v: 1 as const,
      type: "callback" as const,
      id: "second",
      callId: "provider-1",
      method: "provider.read" as const,
      args: [0],
    };
    await hub.fromHost(host, callback);
    await expect(
      hub.fromWorker(other, { v: 1, type: "reply", id: "second", callId: "provider-1", value: {} }),
    ).rejects.toThrow();
    await expect(
      hub.fromWorker(worker, {
        v: 1,
        type: "reply",
        id: "second",
        callId: "provider-1",
        value: { seq: 0, chunk: "invalid!", done: true },
      }),
    ).rejects.toThrow();
    await hub.fromWorker(worker, {
      v: 1,
      type: "reply",
      id: "second",
      callId: "provider-1",
      value: { seq: 0, chunk: "", done: true },
    });
    expect(host.frames.at(-1)).toMatchObject({ type: "reply", callId: "provider-1" });
    for (let index = 0; index < 45; index++) {
      const callId = `chunk-${index}`;
      await hub.fromHost(host, { ...callback, callId, method: "executeTool" });
      await hub.fromWorker(worker, {
        v: 1,
        type: "reply",
        id: "second",
        callId,
        value: "x".repeat(220_000),
      });
      if (worker.frames.some((frame) => frame.type === "end" && frame.id === "second")) break;
    }
    expect(worker.frames).toContainEqual(expect.objectContaining({ type: "end", id: "second" }));
    expect(host.frames.at(-1)).toMatchObject({ type: "cancel", id: "second" });
    hub.detach();
    const nextHost = wire();
    hub.attach(nextHost, "owner", "first");
    await hub.fromHost(nextHost, healthFrame());
    await hub.request(
      { ...hermesRequest(currentGeneration, "new-run"), id: "new-operation" },
      worker,
    );
    expect(nextHost.frames).toEqual([]);
    hub.detach();
  });
  it("rejects a grant minted before a same-registration reconnect", async () => {
    const authorize = vi.fn(async () => true);
    const hub = new HostHub(authorize);
    const first = wire();
    const second = wire();
    const worker = wire();
    hub.attach(first, "owner", "registration");
    await hub.fromHost(first, healthFrame());
    const grantGeneration = hub.health?.generation;
    expect(grantGeneration).toBeTruthy();
    expect(grantGeneration).not.toBe("registration");
    hub.attach(second, "owner", "registration");
    await hub.fromHost(second, healthFrame());
    expect(hub.health?.generation).not.toBe(grantGeneration);
    await hub.request(hermesRequest(grantGeneration!), worker);
    expect(second.frames).toEqual([]);
    expect(worker.frames.at(-1)).toMatchObject({ type: "end", problem: expect.any(Object) });
    expect(authorize).not.toHaveBeenCalled();
    hub.detach();
  });
  it("revokes the broker when the host reconnects between health and submission", async () => {
    const hub = new HostHub(async () => true);
    const first = wire();
    const second = wire();
    hub.attach(first, "owner", "registration");
    await hub.fromHost(first, healthFrame());
    const grant = {
      id: crypto.randomUUID(),
      token: "a".repeat(43),
      expiresAt: Date.now() + 60_000,
    };
    const revoke = vi.fn();
    const open = vi.fn();
    const broker = { grant, revoke, open } as unknown as HermesProviderBroker;
    const client = {
      health: async () => hub.health,
      request: async function* (
        operation: HostRequest["operation"],
        context: { userId: string; spaceId: string; botId: string; runId: string },
        _callback: unknown,
        operationId: string,
      ) {
        const worker = wire();
        await hub.request(
          {
            v: 1,
            type: "request",
            id: operationId,
            scope: {
              userId: context.userId,
              spaceId: context.spaceId,
              botId: context.botId,
              runId: context.runId,
            },
            operation,
          },
          worker,
        );
        if (worker.frames.at(-1)?.type === "end")
          throw new Error("Host operation is unavailable for this run.");
        yield {
          v: 1,
          type: "stream",
          id: operationId,
          seq: 0,
          channel: "event",
          data: { type: "done" },
        };
      },
    } as unknown as HostClient;
    const remote = new RemoteHostRuntime(client, "hermes", async (_request, _context, fence) => {
      hub.attach(second, "owner", "registration");
      await hub.fromHost(second, healthFrame());
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
          credentialId: "fixture",
          provider: "fixture",
          modelId: "fixture-model",
          effort: "high",
        },
      };
      return { broker, scope };
    });
    const run: AgentRunRequest = {
      botId: "bot",
      threadId: "thread",
      runId: "run",
      prompt: "hi",
      instructions: "",
      history: [],
      tools: "none",
      model: {
        provider: "fixture",
        id: "fixture-model",
        thinkingLevel: "high",
        runtimePin: {
          runtimeKind: "hermes",
          provider: "fixture",
          modelId: "fixture-model",
          effort: "high",
          credentialId: "fixture",
          revision: 1,
        } as AgentRunRequest["model"]["runtimePin"],
      },
    };
    const consume = async () => {
      for await (const _ of remote.run(run, { userId: "owner", spaceId: "space" })) {
        // Rejection precedes any runtime event.
      }
    };
    await expect(consume()).rejects.toThrow("Host operation is unavailable");
    expect(second.frames).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();
    hub.detach();
  });
  it.each(["cancel", "disconnect"])("does not forward a queued probe after %s", async (action) => {
    const authorize = vi.fn(async () => true);
    const hub = new HostHub(authorize),
      host = wire(),
      worker = wire();
    hub.attach(host, "owner", "first");
    try {
      await hub.request(probe("first"), worker);
      await hub.request(probe("second"), worker);
      const queued = hub.request(probe("queued"), worker);
      expect(host.frames).toHaveLength(2);
      expect(authorize).toHaveBeenCalledTimes(2);
      if (action === "cancel") await hub.fromWorker(worker, { v: 1, type: "cancel", id: "queued" });
      else hub.detach();
      await queued;
      // A final cancellation can overtake the end frame on the initiating socket.
      await hub.fromWorker(worker, { v: 1, type: "cancel", id: "queued" });
      await expect(
        hub.fromWorker(wire(), { v: 1, type: "cancel", id: "queued" }),
      ).rejects.toThrow();
      if (action === "cancel") await hub.fromHost(host, { v: 1, type: "end", id: "first" });
      else hub.attach(wire(), "owner", "second");
      expect(
        host.frames.filter((frame) => frame.type === "request").map((frame) => frame.id),
      ).toEqual(["first", "second"]);
      expect(worker.frames).toContainEqual(
        expect.objectContaining({ id: "queued", type: "end", problem: expect.any(Object) }),
      );
    } finally {
      hub.detach();
    }
  });
  it("round-trips stdout, stderr and exit only to the initiating worker", async () => {
    const hub = new HostHub(async () => true),
      host = wire(),
      worker = wire(),
      other = wire();
    hub.attach(host, "owner", "first");
    await hub.request(request, worker);
    for (const [seq, channel, data] of [
      [0, "stdout", "ok"],
      [1, "stderr", "note"],
      [2, "exit", 0],
    ] as const) {
      await hub.fromHost(host, { v: 1, type: "stream", id: request.id, seq, channel, data });
      await hub.fromWorker(worker, { v: 1, type: "ack", id: request.id, seq });
    }
    await expect(hub.fromWorker(other, { v: 1, type: "cancel", id: request.id })).rejects.toThrow();
    expect(other.frames).toEqual([]);
    expect(worker.frames.map((frame) => frame.type)).toEqual(["stream", "stream", "stream"]);
    await hub.fromHost(host, { v: 1, type: "end", id: request.id });
    hub.detach();
  });
  it("fences host output after the cumulative bridge limit", async () => {
    const hub = new HostHub(async () => true),
      host = wire(),
      worker = wire();
    hub.attach(host, "owner", "first");
    await hub.request(request, worker);
    for (let seq = 0; seq < 45; seq++) {
      await hub.fromHost(host, {
        v: 1,
        type: "stream",
        id: request.id,
        seq,
        channel: "stdout",
        data: "x".repeat(220_000),
      });
      if (worker.frames.some((frame) => frame.type === "end")) break;
      await hub.fromWorker(worker, { v: 1, type: "ack", id: request.id, seq });
    }
    expect(worker.frames.at(-1)).toMatchObject({ type: "end", id: request.id });
    expect(host.frames.at(-1)).toMatchObject({ type: "cancel", id: request.id });
    hub.detach();
  });
  it("forwards cancellation and never retries a disconnected run on reconnect", async () => {
    const hub = new HostHub(async () => true),
      host = wire(),
      worker = wire();
    const detach = hub.attach(host, "owner", "first");
    await hub.request(request, worker);
    detach();
    expect(worker.frames.at(-1)).toMatchObject({
      type: "end",
      problem: { kind: "problem", code: "runtime-unavailable" },
    });
    const next = wire();
    hub.attach(next, "owner", "second");
    expect(next.frames).toEqual([]);
    await hub.request(request, worker);
    expect(next.frames).toEqual([]);
    await hub.request({ ...request, id: "new" }, worker);
    expect(next.frames).toEqual([]);
    expect(worker.frames.at(-1)).toMatchObject({
      type: "end",
      problem: { reason: "This run lost its host — start a new run." },
    });
    await hub.request(
      { ...request, id: "new-run-request", scope: { ...request.scope, runId: "new-run" } },
      worker,
    );
    await hub.fromWorker(worker, { v: 1, type: "cancel", id: "new-run-request" });
    expect(next.frames.at(-1)).toEqual({ v: 1, type: "cancel", id: "new-run-request" });
    hub.detach();
  });
  it("bounds concurrent requests before asynchronous authorization completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hub = new HostHub(async () => {
        await gate;
        return true;
      }),
      host = wire(),
      worker = wire();
    hub.attach(host, "owner", "first");
    const calls = Array.from({ length: HOST_IN_FLIGHT + 1 }, (_, i) =>
      hub.request({ ...request, id: `r${i}` }, worker),
    );
    expect(worker.frames.at(-1)).toMatchObject({
      type: "end",
      problem: { reason: "Host service is busy — try a new run later." },
    });
    release();
    await Promise.all(calls);
    expect(host.frames).toHaveLength(HOST_IN_FLIGHT);
    hub.detach();
  });
  it("rejects streams exceeding the acknowledgement window", async () => {
    const hub = new HostHub(async () => true),
      host = wire(),
      worker = wire();
    hub.attach(host, "owner", "first");
    await hub.request(request, worker);
    for (let seq = 0; seq < HOST_WINDOW; seq++)
      await hub.fromHost(host, {
        v: 1,
        type: "stream",
        id: request.id,
        seq,
        channel: "stdout",
        data: "x",
      });
    await expect(
      hub.fromHost(host, {
        v: 1,
        type: "stream",
        id: request.id,
        seq: HOST_WINDOW,
        channel: "stdout",
        data: "x",
      }),
    ).rejects.toThrow("window");
    hub.detach();
  });
  it("refuses inactive or foreign runs before forwarding anything", async () => {
    const authorize = vi.fn(async () => false),
      hub = new HostHub(authorize),
      host = wire(),
      worker = wire();
    hub.attach(host, "owner", "first");
    await hub.request(request, worker);
    expect(host.frames).toEqual([]);
    expect(authorize).toHaveBeenCalledWith(request, "owner", "first");
    hub.detach();
  });
});

it("does not forward a canceled request after its asynchronous grant resolves", async () => {
  let allow!: (value: boolean) => void;
  const hub = new HostHub(
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  const host = wire(),
    worker = wire();
  hub.attach(host, "owner", "generation");
  const pending = hub.request(request, worker);
  hub.cancel(request.id, worker);
  allow(true);
  await pending;
  expect(host.frames.some((frame) => frame.type === "request")).toBe(false);
  expect(worker.frames.at(-1)).toMatchObject({ type: "end", problem: expect.any(Object) });
  hub.detach();
});
