import path from "node:path";
import {
  HOST_FRAME_BYTES,
  HostMcpRegistrationSchema,
  hostSocketUrl,
} from "@ardurbot/contracts/host-bridge";
import { receiveFrames, wsWire } from "@ardurbot/host-runtime/bridge-wire";
import { HostAgent } from "@ardurbot/host-runtime/host-agent";
import WebSocket from "ws";
import * as z from "zod";
import { readHostMcpConfiguration } from "./mcp-configuration.js";

const Config = z.strictObject({
  mcpServers: z.array(HostMcpRegistrationSchema).max(200).default([]),
  apiUrl: z.string().url(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  root: z.string().max(4096).refine(path.isAbsolute),
  hostRoots: z.array(z.string().max(4096).refine(path.isAbsolute)).max(32),
});
let socket: WebSocket | undefined;
let agent: HostAgent | undefined;
let stopped = false;
let configuration: z.infer<typeof Config> | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let healthTimer: ReturnType<typeof setInterval> | undefined;
let mcpTimer: ReturnType<typeof setInterval> | undefined;
let failures = 0;
const idle = setInterval(() => undefined, 60_000);
function state(connected: boolean) {
  process.send?.({ type: "host-state", connected });
}
async function connect() {
  if (stopped || !configuration) return;
  const config = configuration;
  try {
    let sendWire: ReturnType<typeof wsWire> | undefined;
    agent = new HostAgent(config, {
      send: (frame) =>
        sendWire ? sendWire.send(frame) : Promise.reject(new Error("Host is not connected.")),
      close: () => socket?.close(),
    });
    await agent.initialize();
    await agent.configureMcp(await readHostMcpConfiguration(config));
    socket = new WebSocket(hostSocketUrl(config.apiUrl), {
      headers: { authorization: `Bearer ${config.token}` },
      maxPayload: HOST_FRAME_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 5000,
      followRedirects: false,
    });
    const current = socket;
    const wire = wsWire(current);
    sendWire = wire;
    const host = agent;
    let healthBusy = false;
    let mcpRefresh: Promise<void> | undefined;
    const refreshMcp = async () => {
      mcpRefresh ??= (async () => {
        try {
          await host.configureMcp(await readHostMcpConfiguration(config));
        } catch {
          await host.configureMcp([]);
        } finally {
          mcpRefresh = undefined;
        }
      })();
      await mcpRefresh;
    };
    host.refreshMcp = refreshMcp;
    const health = async () => {
      if (healthBusy) return;
      healthBusy = true;
      try {
        await wire.send({ v: 1, type: "health", health: await host.health() });
      } catch {
        current.close();
      } finally {
        healthBusy = false;
      }
    };
    receiveFrames(
      current,
      (frame) => host.receive(frame),
      () => {
        host.close();
        state(false);
        clearInterval(healthTimer);
        clearInterval(mcpTimer);
        if (!stopped)
          reconnect = setTimeout(
            () => void connect(),
            Math.min(30_000, 500 * 2 ** Math.min(failures++, 6)),
          );
      },
    );
    current.once("open", () => {
      failures = 0;
      state(true);
      void health();
      healthTimer = setInterval(() => void health(), 30_000);
      mcpTimer = setInterval(() => void refreshMcp(), 5000);
    });
    // A revoked token needs explicit setup. Never spin on a permanent authentication failure.
    current.on("unexpected-response", (_request, response) => {
      response.resume();
      stopped = true;
      current.terminate();
      state(false);
    });
  } catch {
    state(false);
    agent?.close();
    if (!stopped)
      reconnect = setTimeout(
        () => void connect(),
        Math.min(30_000, 500 * 2 ** Math.min(failures++, 6)),
      );
  }
}
function stop() {
  stopped = true;
  clearInterval(idle);
  clearTimeout(reconnect);
  clearInterval(healthTimer);
  clearInterval(mcpTimer);
  agent?.close();
  socket?.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("message", (message) => {
  if (message && typeof message === "object" && "type" in message && message.type === "stop") {
    stop();
    return;
  }
  if (configuration) return;
  const parsed = Config.safeParse(message);
  if (!parsed.success) {
    stop();
    return;
  }
  configuration = parsed.data;
  void connect();
});
process.once("disconnect", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.on("uncaughtException", stop);
process.on("unhandledRejection", stop);
