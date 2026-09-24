import type { HostFrame, HostHealth, HostRequest } from "@ardurbot/contracts/host-bridge";
import {
  encodeHostFrame,
  HOST_IN_FLIGHT,
  HOST_TOTAL_BYTES,
  HOST_WINDOW,
} from "@ardurbot/contracts/host-bridge";
import type { HostWire } from "@ardurbot/host-runtime/bridge-wire";
import { hostLostProblem } from "@ardurbot/host-runtime/bridge-wire";

type Pending = {
  request: HostRequest;
  worker: HostWire;
  seq: number;
  ack: number;
  bytes: number;
  calls: Set<string>;
  timer: ReturnType<typeof setTimeout>;
};
/** One deployment, one owner, one host generation. Nothing is replayed after detach. */
export class HostHub {
  private host?: { wire: HostWire; ownerId: string; generation: string };
  private pending = new Map<string, Pending>();
  private seen = new Set<string>();
  private lostRuns = new Set<string>();
  private completed = new WeakMap<HostWire, Set<string>>();
  health: HostHealth | null = null;
  constructor(
    private readonly authorize: (
      request: HostRequest,
      ownerId: string,
      generation: string,
    ) => Promise<boolean>,
  ) {}
  get connected() {
    return !!this.host;
  }
  attach(wire: HostWire, ownerId: string, generation: string) {
    this.detach();
    this.host = { wire, ownerId, generation };
    return () => {
      if (this.host?.wire === wire) this.detach();
    };
  }
  detach() {
    const old = this.host;
    this.host = undefined;
    this.health = null;
    old?.wire.close();
    for (const pending of this.pending.values()) {
      this.lostRuns.add(pending.request.scope.runId);
      clearTimeout(pending.timer);
      void pending.worker
        .send({
          v: 1,
          type: "end",
          id: pending.request.id,
          problem: hostLostProblem(pending.request),
        })
        .catch(() => pending.worker.close());
    }
    this.pending.clear();
  }
  async request(request: HostRequest, worker: HostWire) {
    const host = this.host;
    if (
      !host ||
      this.pending.size >= HOST_IN_FLIGHT ||
      this.seen.has(request.id) ||
      (this.lostRuns.has(request.scope.runId) && request.operation.op !== "board.run") ||
      this.lostRuns.size >= 100_000
    ) {
      await worker.send({
        v: 1,
        type: "end",
        id: request.id,
        problem: hostLostProblem(
          request,
          this.lostRuns.has(request.scope.runId)
            ? "This run lost its host — start a new run."
            : host
              ? "Host service is busy — try a new run later."
              : undefined,
        ),
      });
      return;
    }
    // Reserve before awaiting database authorization so concurrent opens cannot overbook.
    const pending: Pending = {
      request,
      worker,
      seq: -1,
      ack: -1,
      bytes: 0,
      calls: new Set(),
      timer: setTimeout(() => this.cancel(request.id, worker), 15 * 60_000),
    };
    pending.timer.unref?.();
    this.pending.set(request.id, pending);
    try {
      if (!(await this.authorize(request, host.ownerId, host.generation)) || this.host !== host)
        throw new Error("Unauthorized host operation.");
      this.seen.add(request.id);
      // A bounded tombstone set lasts for the API process lifetime; worker request IDs are random.
      if (this.seen.size > 100_000) {
        this.detach();
        throw new Error("Host request history is full.");
      }
      await host.wire.send(request);
    } catch {
      this.finish(request.id);
      await worker.send({
        v: 1,
        type: "end",
        id: request.id,
        problem: hostLostProblem(request, "Host operation is unavailable for this run."),
      });
    }
  }
  async fromHost(wire: HostWire, frame: HostFrame) {
    if (this.host?.wire !== wire) return;
    if (frame.type === "health") {
      this.health = frame.health;
      return;
    }
    if (!("id" in frame)) throw new Error("Unexpected host frame.");
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    if (!(await this.authorize(pending.request, this.host.ownerId, this.host.generation))) {
      this.cancel(frame.id, pending.worker);
      return;
    }
    if (this.host?.wire !== wire || this.pending.get(frame.id) !== pending) return;
    if (frame.type === "stream") {
      if (frame.seq !== pending.seq + 1 || frame.seq - pending.ack > HOST_WINDOW)
        throw new Error("Host stream window exceeded.");
      pending.seq = frame.seq;
    } else if (frame.type === "callback") {
      if (
        pending.request.operation.op !== "runtime.turn" ||
        pending.calls.size >= HOST_WINDOW ||
        pending.calls.has(frame.callId)
      )
        throw new Error("Unexpected host callback.");
      pending.calls.add(frame.callId);
    } else if (frame.type !== "end") throw new Error("Unexpected host frame.");
    pending.bytes += Buffer.byteLength(encodeHostFrame(frame));
    if (pending.bytes > HOST_TOTAL_BYTES) {
      this.cancel(frame.id, pending.worker);
      return;
    }
    await pending.worker.send(frame);
    if (frame.type === "end") this.finish(frame.id);
  }
  async fromWorker(worker: HostWire, frame: HostFrame) {
    if (frame.type === "request") return this.request(frame, worker);
    if (!("id" in frame)) throw new Error("Unexpected worker frame.");
    const pending = this.pending.get(frame.id);
    if (!pending) {
      // A terminal frame may overtake the consumer's final ACK. Absorb it only
      // on the same worker socket; it must never be forwarded to another run.
      if (
        (frame.type === "ack" || frame.type === "cancel" || frame.type === "reply") &&
        this.completed.get(worker)?.has(frame.id)
      )
        return;
      throw new Error("Unknown worker operation.");
    }
    if (pending.worker !== worker) throw new Error("Unknown worker operation.");
    if (frame.type === "cancel") return this.cancel(frame.id, worker);
    if (frame.type === "ack") {
      if (frame.seq <= pending.ack || frame.seq > pending.seq)
        throw new Error("Invalid acknowledgement.");
      pending.ack = frame.seq;
    } else if (frame.type === "reply") {
      if (!pending.calls.delete(frame.callId)) throw new Error("Unknown callback.");
    } else throw new Error("Unexpected worker frame.");
    await this.host?.wire.send(frame);
  }
  cancel(id: string, worker: HostWire) {
    const pending = this.pending.get(id);
    if (!pending || pending.worker !== worker) return;
    void this.host?.wire.send({ v: 1, type: "cancel", id }).catch(() => this.detach());
    void worker
      .send({
        v: 1,
        type: "end",
        id,
        problem: hostLostProblem(pending.request, "Host operation stopped — start a new run."),
      })
      .catch(() => worker.close());
    this.finish(id);
  }
  closeWorker(worker: HostWire) {
    for (const [id, p] of this.pending) if (p.worker === worker) this.cancel(id, worker);
  }
  private finish(id: string) {
    const p = this.pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      const completed = this.completed.get(p.worker) ?? new Set<string>();
      completed.add(id);
      if (completed.size > 64) completed.delete(completed.values().next().value!);
      this.completed.set(p.worker, completed);
    }
    this.pending.delete(id);
  }
}
