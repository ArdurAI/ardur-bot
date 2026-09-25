import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import type { HostFrame } from "@ardurbot/contracts/host-bridge";
import { decodeHostFrame, encodeHostFrame } from "@ardurbot/contracts/host-bridge";
import type { HostWire } from "@ardurbot/host-runtime/bridge-wire";
import { HostAgent } from "@ardurbot/host-runtime/host-agent";
import { HostClient } from "@ardurbot/host-runtime/host-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteHostRuntime } from "../../../packages/adapters/src/remote-host-runtime.js";
import { RemoteHostSandboxProvider } from "../../../packages/adapters/src/remote-host-sandbox.js";
import { HostHub } from "./host-hub.js";

vi.mock("@ardurbot/host-runtime/host-environment", async (original) => ({
  ...(await original<object>()),
  getHostEnvironment: async () => ({ env: { PATH: process.env.PATH } }),
  inspectHostEnvironment: async () => ({ tools: [{ name: "gh", status: "signed in" }] }),
}));
const transport = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("ws", () => ({
  default: vi.fn(function socket() {
    return transport.open();
  }),
}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const context = {
  operationId: "operation",
  traceId: "trace",
  userId: "owner",
  spaceId: "space",
  botId: "bot",
  runId: "run",
  signal: new AbortController().signal,
};
async function fixture(events: AgentRuntimeEvent[] = [{ type: "done" }]) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "host-roundtrip-")));
  const hub = new HostHub(async () => true);
  const fakeRuntime: AgentRuntime = {
    describe: () => ({
      id: "fixture",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    }),
    abort: async () => undefined,
    run: async function* () {
      yield* events;
    },
  };
  let agent: HostAgent;
  const host: HostWire = {
    send: async (frame) => agent.receive(decodeHostFrame(encodeHostFrame(frame))),
    close: () => agent.close(),
  };
  agent = new HostAgent(
    { root, hostRoots: [] },
    {
      send: async (frame) => hub.fromHost(host, decodeHostFrame(encodeHostFrame(frame))),
      close: () => hub.detach(),
    },
    { "claude-code": fakeRuntime, "codex-app-server": fakeRuntime },
  );
  await agent.initialize();
  hub.attach(host, "owner", "generation");
  transport.open.mockImplementation(() => {
    const socket = new EventEmitter() as EventEmitter & {
      readyState: number;
      bufferedAmount: number;
      close(): void;
      send(data: string, callback: (error?: Error) => void): void;
    };
    socket.readyState = 1;
    socket.bufferedAmount = 0;
    const worker: HostWire = {
      send: async (frame: HostFrame) => {
        queueMicrotask(() => socket.emit("message", Buffer.from(encodeHostFrame(frame)), false));
      },
      close: () => socket.close(),
    };
    socket.close = () => {
      if (socket.readyState === 3) return;
      socket.readyState = 3;
      hub.closeWorker(worker);
      socket.emit("close");
    };
    socket.send = (data, callback) => {
      void hub.fromWorker(worker, decodeHostFrame(data)).then(
        () => callback(),
        () => callback(new Error("Connection stopped.")),
      );
    };
    queueMicrotask(() => socket.emit("open"));
    return socket;
  });
  cleanup.push(async () => {
    hub.detach();
    agent.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    hub,
    agent,
    client: new HostClient({ apiUrl: "http://127.0.0.1:3100", encryptionKey: "fixture-key" }),
  };
}
describe("worker to API hub to host protocol", () => {
  it.each([
    ["claude-code", "anthropic"],
    ["codex-app-server", "openai-codex"],
  ] as const)("round-trips optional cache usage and completion for %s", async (kind, provider) => {
    const events: AgentRuntimeEvent[] = [undefined, 0, 42].map((cachedTokens) => ({
      type: "usage",
      provider,
      model: "fixture-model",
      inputTokens: 100,
      outputTokens: 10,
      ...(cachedTokens === undefined ? {} : { cachedTokens }),
    }));
    events.push({ type: "done", text: "Complete" });
    const { client } = await fixture(events);
    const runtime = new RemoteHostRuntime(client, kind);
    const received: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run",
        instructions: "",
        prompt: "Hello",
        history: [],
        tools: "none",
        model: {
          provider,
          id: "fixture-model",
          thinkingLevel: "low",
          runtimePin: {
            runtimeKind: kind,
            provider,
            modelId: "fixture-model",
            credentialId: "credential",
            effort: "low",
            revision: 1,
          },
        },
      },
      context,
    ))
      received.push(event);
    expect(received).toEqual(events);
  });
  it("round-trips an actual confined command and file through serialized frames without network listeners", async () => {
    const { client } = await fixture();
    const output = [];
    for await (const frame of client.request(
      { op: "computer.exec", homeKey: "computer", argv: ["echo", "hello"] },
      context,
    ))
      output.push(frame);
    expect(output).toEqual([
      expect.objectContaining({ channel: "stdout", data: "hello\n", seq: 0 }),
      expect.objectContaining({ channel: "exit", data: 0, seq: 1 }),
    ]);
    await client.result(
      {
        op: "computer.files.write",
        homeKey: "computer",
        path: "note.txt",
        content: Buffer.from("saved").toString("base64"),
      },
      context,
    );
    const chunks: string[] = [];
    for await (const frame of client.request(
      { op: "computer.files.read", homeKey: "computer", path: "note.txt" },
      context,
    ))
      chunks.push(Buffer.from(String(frame.data), "base64").toString());
    expect(chunks.join("")).toBe("saved");
  });
  it("delivers a RuntimeProblem when the host disappears during an active operation", async () => {
    const { client, hub, agent } = await fixture();
    const receive = vi.spyOn(agent, "receive").mockImplementation(async () => undefined);
    const completed = (async () => {
      for await (const _frame of client.request(
        { op: "computer.exec", homeKey: "computer", argv: ["echo", "hello"] },
        context,
      )) {
        /* Wait for a terminal result. */
      }
    })();
    const failure = expect(completed).rejects.toMatchObject({
      problem: { kind: "problem", code: "runtime-unavailable" },
    });
    await vi.waitFor(() => expect(receive).toHaveBeenCalled());
    hub.detach();
    await failure;
  });
});

it("round-trips the run inventory without consulting the worker's PATH", async () => {
  const { client } = await fixture();
  const sandbox = new RemoteHostSandboxProvider(client);
  const note = await sandbox.environmentNote(
    { id: "host:computer", botId: "computer", kind: "desktop", providerRef: "host:computer" },
    context,
  );
  expect(note).toContain("Tools on this computer: gh (signed in)");
  expect(note).not.toContain("\n");
});
