import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type {
  HostFrame,
  HostHealth,
  HostOperation,
  HostRequest,
} from "@ardurbot/contracts/host-bridge";
import {
  HOST_FRAME_BYTES,
  HOST_WINDOW,
  HostHealthSchema,
  HostScopeSchema,
  hostSocketUrl,
} from "@ardurbot/contracts/host-bridge";
import { RuntimePinError } from "@ardurbot/contracts/runtime-pins";
import WebSocket from "ws";
import { hostLostProblem, receiveFrames, wsWire } from "./bridge-wire.js";
import { RuntimeQueue } from "./runtimes/native-process.js";
import { hostWorkerToken } from "./worker-auth.js";

type CallbackFrame = Extract<HostFrame, { type: "callback" }>;
export type HostStreamFrame = Extract<HostFrame, { type: "stream" }>;
export class HostClient {
  constructor(private readonly options: { apiUrl: string; encryptionKey: string }) {}
  async health(): Promise<HostHealth | null> {
    const url = new URL("/api/host-bridge/health", this.options.apiUrl);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${hostWorkerToken(this.options.encryptionKey)}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Host service is unavailable.");
    const value = await response.json();
    return value === null ? null : HostHealthSchema.parse(value);
  }
  async *request(
    operation: HostOperation,
    context: Partial<AdapterContext>,
    callback?: (frame: CallbackFrame) => Promise<unknown>,
  ): AsyncIterable<HostStreamFrame> {
    const request: HostRequest = {
      v: 1,
      type: "request",
      id: randomUUID(),
      scope: HostScopeSchema.parse({
        userId: context.userId,
        spaceId: context.spaceId,
        botId: context.botId,
        runId: context.runId,
      }),
      operation,
    };
    const queue = new RuntimeQueue<HostFrame>();
    const socket = new WebSocket(hostSocketUrl(this.options.apiUrl, true), {
      headers: { authorization: `Bearer ${hostWorkerToken(this.options.encryptionKey)}` },
      maxPayload: HOST_FRAME_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 5000,
      followRedirects: false,
    });
    const wire = wsWire(socket);
    let buffered = 0;
    let finished = false;
    let callbackCount = 0;
    let expectedSeq = 0;
    receiveFrames(
      socket,
      (frame) => {
        if (!("id" in frame) || frame.id !== request.id) {
          socket.close();
          return;
        }
        if (++buffered > HOST_WINDOW + 2) {
          socket.close();
          return;
        }
        queue.push(frame);
      },
      () => queue.end(finished ? undefined : new RuntimePinError(hostLostProblem(request))),
    );
    socket.once("open", () => {
      void wire.send(request).catch(() => socket.close());
    });
    const abort = () => {
      void wire
        .send({ v: 1, type: "cancel", id: request.id })
        .finally(() => socket.close())
        .catch(() => undefined);
      queue.end(new RuntimePinError(hostLostProblem(request, "Host operation stopped.")));
    };
    context.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15 * 60_000);
    timer.unref();
    try {
      if (context.signal?.aborted) {
        abort();
        throw new RuntimePinError(hostLostProblem(request, "Host operation stopped."));
      }
      for await (const frame of queue) {
        buffered--;
        if (frame.type === "end") {
          finished = true;
          if (frame.problem) throw new RuntimePinError(frame.problem);
          return;
        }
        if (frame.type === "stream") {
          if (frame.seq !== expectedSeq++) throw new Error("Host stream sequence mismatch.");
          yield frame;
          await wire.send({ v: 1, type: "ack", id: request.id, seq: frame.seq });
        } else if (frame.type === "callback" && callback && ++callbackCount < 10_000) {
          // Do not block event consumption while a worker callback itself uses a host computer.
          void callback(frame)
            .then(
              (value) =>
                wire.send({ v: 1, type: "reply", id: request.id, callId: frame.callId, value }),
              () =>
                wire.send({
                  v: 1,
                  type: "reply",
                  id: request.id,
                  callId: frame.callId,
                  failed: true,
                }),
            )
            .catch(() => socket.close());
        } else throw new Error("Unexpected host response.");
      }
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      if (!finished && socket.readyState === 1)
        await wire.send({ v: 1, type: "cancel", id: request.id }).catch(() => undefined);
      socket.close();
    }
  }
  async result(operation: HostOperation, context: Partial<AdapterContext>) {
    let result: unknown;
    for await (const frame of this.request(operation, context))
      if (frame.channel === "result") result = frame.data;
    return result;
  }
}
