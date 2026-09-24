import type { HostFrame, HostRequest } from "@ardurbot/contracts/host-bridge";
import {
  decodeHostFrame,
  encodeHostFrame,
  HOST_FRAME_BYTES,
} from "@ardurbot/contracts/host-bridge";
import { runtimePinProblem } from "@ardurbot/contracts/runtime-pins";
import type WebSocket from "ws";

export interface HostWire {
  send(frame: HostFrame): Promise<void>;
  close(): void;
}
export function wsWire(socket: WebSocket): HostWire {
  return {
    async send(frame) {
      const data = encodeHostFrame(frame);
      if (socket.readyState !== 1 || socket.bufferedAmount > HOST_FRAME_BYTES * 2) {
        socket.close();
        return Promise.reject(new Error("Host connection backpressure."));
      }
      return new Promise<void>((resolve, reject) =>
        socket.send(data, (error) =>
          error ? reject(new Error("Host connection closed.")) : resolve(),
        ),
      );
    },
    close: () => socket.close(),
  };
}
export function receiveFrames(
  socket: WebSocket,
  receive: (frame: HostFrame) => void | Promise<void>,
  close: () => void,
) {
  let pending = 0;
  let tail = Promise.resolve();
  socket.on("message", (data, binary) => {
    try {
      if (binary || ++pending > 40) throw new Error("Host receive window exceeded.");
      const frame = decodeHostFrame(data.toString());
      tail = tail
        .then(() => receive(frame))
        .then(() => {
          pending--;
        })
        .catch(() => {
          socket.close();
        });
    } catch {
      socket.close();
    }
  });
  socket.on("error", () => socket.close());
  socket.once("close", close);
}
export function hostLostProblem(
  request: HostRequest,
  reason = "Host service disconnected — open the desktop app and start a new run.",
) {
  return runtimePinProblem(
    request.operation.op === "runtime.turn"
      ? request.operation.request.model.runtimePin
      : {
          runtimeKind: "pi",
          provider: null,
          modelId: null,
          effort: null,
          credentialId: null,
          revision: 0,
        },
    "runtime-unavailable",
    reason,
  );
}
