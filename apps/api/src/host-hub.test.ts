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
