import type { HostFrame, HostRequest } from "@ardurbot/contracts/host-bridge";
import { HOST_IN_FLIGHT, HOST_WINDOW } from "@ardurbot/contracts/host-bridge";
import type { HostWire } from "@ardurbot/host-runtime/bridge-wire";
import { describe, expect, it, vi } from "vitest";
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

describe("outbound host hub", () => {
  it("keeps Hermes on a negotiated host and fences provider callbacks to its worker", async () => {
    const hub = new HostHub(async () => true),
      host = wire(),
      worker = wire(),
      other = wire();
    const hermes = {
      ...request,
      operation: {
        op: "runtime.turn" as const,
        homeKey: "bot",
        request: {
          botId: "bot",
          runId: "run",
          threadId: "thread",
          prompt: "hi",
          instructions: "",
          history: [],
          tools: "none" as const,
          model: {
            runtimePin: {
              runtimeKind: "hermes" as const,
              provider: "fixture",
              modelId: "fixture-model",
              effort: "high",
              credentialId: "fixture",
              revision: 1,
            },
            provider: "fixture",
            id: "fixture-model",
            thinkingLevel: "high" as const,
          },
          providerBroker: {
            protocol: 1 as const,
            id: crypto.randomUUID(),
            token: "a".repeat(43),
            expiresAt: Date.now() + 60_000,
            hostGeneration: "first",
          },
        },
      },
    };
    hub.attach(host, "owner", "first");
    await hub.request(hermes, worker);
    expect(host.frames).toEqual([]);
    hub.health = { capabilities: { providerRelay: 1 } } as typeof hub.health;
    await hub.request({ ...hermes, id: "second" }, worker);
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
    hub.attach(nextHost, "owner", "second");
    hub.health = { capabilities: { providerRelay: 1 } } as typeof hub.health;
    await hub.request(
      {
        ...hermes,
        id: "new-operation",
        scope: { ...hermes.scope, runId: "new-run" },
        operation: {
          ...hermes.operation,
          request: { ...hermes.operation.request, runId: "new-run" },
        },
      },
      worker,
    );
    expect(nextHost.frames).toEqual([]);
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
