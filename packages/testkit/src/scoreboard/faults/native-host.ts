import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { HostScope } from "@ardurbot/contracts/host-bridge";
import type { RuntimePin } from "@ardurbot/contracts/runtime-pins";
import { RuntimePinError } from "@ardurbot/contracts/runtime-pins";
import { HostClient } from "../../../../host-runtime/src/host-client.js";
import { contentDigest } from "../manifest.js";

export interface NativeHostReady {
  type: "host-ready";
  port: number;
  scope: HostScope;
  threadId: string;
  pin: RuntimePin;
}

/** Minimal synthetic host: complete a real WebSocket handshake, then die during a request. */
export async function interruptibleNativeHost(
  input: Omit<NativeHostReady, "type" | "port">,
  reached: (value: Record<string, unknown>) => Promise<void>,
) {
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") return socket.destroy();
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.once("data", () => {
      void reached({
        nativeEffect: "executing",
        nativeTransport: "loopback-websocket",
        pinHash: contentDigest(input.pin),
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.send?.({ type: "host-ready", ...input, port: (server.address() as AddressInfo).port });
  return server;
}

export async function observeNativeDisconnect(input: NativeHostReady) {
  const client = new HostClient({
    apiUrl: `http://127.0.0.1:${input.port}`,
    encryptionKey: "synthetic-matrix-key",
  });
  try {
    for await (const _frame of client.request(
      {
        op: "runtime.turn",
        homeKey: "matrix",
        request: {
          botId: input.scope.botId,
          runId: input.scope.runId,
          threadId: input.threadId,
          prompt: "Synthetic native turn",
          instructions: "Synthetic native instructions",
          history: [],
          tools: "none",
          model: {
            runtimePin: input.pin,
            provider: "anthropic",
            id: "fixture-native",
            thinkingLevel: "low",
          },
        },
      },
      { ...input.scope, signal: AbortSignal.timeout(15000) },
    )) {
      /* The fixture never returns an outcome. */
    }
    return { nativeDisconnectTyped: false, nativePinPreserved: false };
  } catch (error) {
    return {
      nativeDisconnectTyped:
        error instanceof RuntimePinError && error.problem.code === "runtime-unavailable",
      nativePinPreserved:
        error instanceof RuntimePinError &&
        contentDigest(error.problem.pin) === contentDigest(input.pin),
    };
  }
}
