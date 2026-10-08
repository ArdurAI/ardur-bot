import { EventEmitter } from "node:events";
import { COMMAND_REFUSALS, CommandRefusalError } from "@ardurbot/contracts";
import type { HostRequest } from "@ardurbot/contracts/host-bridge";
import { RuntimePinError } from "@ardurbot/contracts/runtime-pins";
import { expect, it, vi } from "vitest";
import { hostLostProblem } from "./bridge-wire.js";
import { HostClient } from "./host-client.js";

const response = vi.hoisted(() => ({
  refusalId: undefined as string | undefined,
  reason: "original error",
}));
// Protocol-only socket: never connects to a host or opens a listening port.
vi.mock("ws", () => ({
  default: class extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    constructor() {
      super();
      queueMicrotask(() => this.emit("open"));
    }
    send(data: string, callback: () => void) {
      const request = JSON.parse(data) as HostRequest;
      callback();
      if (request.type === "request")
        queueMicrotask(() =>
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                v: 1,
                type: "end",
                id: request.id,
                problem: {
                  ...hostLostProblem(request, response.reason),
                  refusalId: response.refusalId,
                },
              }),
            ),
            false,
          ),
        );
    }
    close() {
      this.emit("close");
    }
  },
}));

async function refused() {
  const client = new HostClient({
    apiUrl: "http://example.invalid",
    encryptionKey: "fake-protocol-test-key",
  });
  for await (const _frame of client.request(
    { op: "computer.files.read", homeKey: "bot", path: "/outside.txt" },
    {
      operationId: "operation",
      userId: "owner",
      spaceId: "space",
      botId: "bot",
      runId: "run",
    },
  )) {
    /* no stream frames expected */
  }
}
it("preserves the producer's file refusal identifier across the host wire", async () => {
  response.refusalId = "file-location";
  response.reason = COMMAND_REFUSALS["file-location"];
  await expect(refused()).rejects.toBeInstanceOf(CommandRefusalError);
  await expect(refused()).rejects.toMatchObject({
    refusalId: "file-location",
    message: response.reason,
  });
});
it.each([undefined, "future-refusal"])(
  "keeps ordinary/unknown host errors original (%s)",
  async (refusalId) => {
    response.refusalId = refusalId;
    response.reason = COMMAND_REFUSALS["file-location"];
    await expect(refused()).rejects.toBeInstanceOf(RuntimePinError);
    await expect(refused()).rejects.toMatchObject({ message: response.reason });
  },
);
