import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import type { HostFrame, HostOperation, HostRequest } from "@ardurbot/contracts/host-bridge";
import { decodeHostFrame, encodeHostFrame, HOST_WINDOW } from "@ardurbot/contracts/host-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { HostAgent } from "./host-agent.js";
import { nativeEnvironment } from "./runtimes/native-process.js";

vi.mock("./runtimes/claude-code-runtime.js", async (original) => ({
  ...(await original<object>()),
  probeClaude: async () => ({
    runtimeKind: "claude-code",
    available: true,
    version: "2.1.259",
    models: [],
  }),
}));
vi.mock("./runtimes/codex-app-server-runtime.js", async (original) => ({
  ...(await original<object>()),
  probeCodex: async () => ({
    runtimeKind: "codex-app-server",
    available: true,
    version: "0.156.1",
    models: [],
  }),
}));
vi.mock("./host-environment.js", async (original) => ({
  ...(await original<object>()),
  getHostEnvironment: async () => ({ env: { PATH: process.env.PATH } }),
  inspectHostEnvironment: async () => ({
    tools: [{ name: "gh", version: "2.80.0", status: "signed in" }],
    diagnostic:
      "Your login shell profile failed to load (zsh, exit 1); commands run with a default PATH",
  }),
}));
const roots: string[] = [];
const agents: HostAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) agent.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
const request = (operation: HostOperation): HostRequest => ({
  v: 1,
  type: "request",
  id: "req",
  scope: { userId: "owner", spaceId: "space", botId: "bot", runId: "run" },
  operation,
});
const turn: HostOperation = {
  op: "runtime.turn",
  homeKey: "bot",
  request: {
    botId: "bot",
    runId: "run",
    threadId: "thread",
    prompt: "hello",
    instructions: "instructions",
    history: [],
    tools: "none",
    model: {
      runtimePin: {
        runtimeKind: "claude-code",
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        effort: "low",
        credentialId: "credential",
        revision: 1,
      },
      provider: "anthropic",
      id: "claude-opus-4-6",
      thinkingLevel: "low",
    },
  },
};
async function fixture(runtime?: AgentRuntime) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "host-agent-")));
  roots.push(root);
  const frames: HostFrame[] = [];
  const agent = new HostAgent(
    { root, hostRoots: [root] },
    {
      send: async (frame) => {
        frames.push(decodeHostFrame(encodeHostFrame(frame)));
      },
      close: vi.fn(),
    },
    runtime ? { "claude-code": runtime, "codex-app-server": runtime } : undefined,
  );
  agents.push(agent);
  await agent.initialize();
  return { root, frames, agent };
}
function fakeRuntime(events: number): AgentRuntime {
  return {
    describe: () => ({
      id: "fixture",
      adapterVersion: "1",
      contractVersion: "1",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    }),
    abort: async () => undefined,
    run: async function* () {
      for (let i = 0; i < events; i++) yield { type: "text", text: `event ${i}` };
    },
  };
}
describe("host process operations", () => {
  it("streams exec stdout, stderr, and exit through the existing provider", async () => {
    vi.spyOn(DesktopSandboxProvider.prototype, "execute").mockImplementation(async function* () {
      yield { type: "stdout", data: "ok" };
      yield { type: "stderr", data: "note" };
      yield { type: "exit", code: 0 };
    });
    const { agent, frames } = await fixture();
    await agent.receive(request({ op: "computer.exec", homeKey: "bot", argv: ["echo", "ok"] }));
    await vi.waitFor(() => expect(frames.at(-1)?.type).toBe("end"));
    expect(frames.filter((f) => f.type === "stream").map((f) => f.channel)).toEqual([
      "stdout",
      "stderr",
      "exit",
    ]);
  });
  it("bounds runtime output until acknowledgements arrive and cancels a blocked producer", async () => {
    const { agent, frames } = await fixture(fakeRuntime(HOST_WINDOW + 3));
    await agent.receive(request(turn));
    await vi.waitFor(() => expect(frames).toHaveLength(HOST_WINDOW));
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(frames).toHaveLength(HOST_WINDOW);
    await agent.receive({ v: 1, type: "ack", id: "req", seq: HOST_WINDOW - 1 });
    await vi.waitFor(() => expect(frames.at(-1)?.type).toBe("end"));
    const blocked = await fixture(fakeRuntime(100));
    await blocked.agent.receive(request(turn));
    await vi.waitFor(() => expect(blocked.frames).toHaveLength(HOST_WINDOW));
    await blocked.agent.receive({ v: 1, type: "cancel", id: "req" });
    await vi.waitFor(() =>
      expect(blocked.frames.at(-1)).toMatchObject({
        type: "end",
        problem: { code: "runtime-unavailable" },
      }),
    );
  });
  it("carries callback results back to native adapters without exporting functions or credentials", async () => {
    const runtime = fakeRuntime(0);
    runtime.run = async function* (request) {
      await request.onRuntimeInfo?.({ runtimeKind: "claude-code", sessionId: "session" });
      yield { type: "text", text: "continued" } satisfies AgentRuntimeEvent;
    };
    const { agent, frames } = await fixture(runtime);
    await agent.receive(request(turn));
    await vi.waitFor(() => expect(frames[0]?.type).toBe("callback"));
    const callback = frames[0];
    if (callback?.type !== "callback") throw new Error("Missing callback");
    await agent.receive({ v: 1, type: "reply", id: "req", callId: callback.callId });
    await vi.waitFor(() => expect(frames.at(-1)?.type).toBe("end"));
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "stream",
        channel: "event",
        data: { type: "text", text: "continued" },
      }),
    );
    const environment = nativeEnvironment({
      PATH: "/usr/bin",
      HOST_TOKEN: "fixture-secret",
      NODE_OPTIONS: "injection",
    });
    expect(environment).toEqual({ PATH: "/usr/bin" });
    expect(JSON.stringify(await agent.health())).not.toMatch(
      /token|account|fixture-secret|injection/i,
    );
  });
  it("streams file chunks inside registered roots and refuses symlink escape in the host", async () => {
    const { agent, frames, root } = await fixture();
    await writeFile(path.join(root, "allowed.txt"), "file contents");
    await agent.receive(
      request({ op: "computer.files.read", homeKey: "bot", path: path.join(root, "allowed.txt") }),
    );
    await vi.waitFor(() => expect(frames.at(-1)?.type).toBe("end"));
    expect(frames[0]).toMatchObject({
      channel: "file",
      data: Buffer.from("file contents").toString("base64"),
    });
    await agent.receive({
      ...request({ op: "computer.files.list", homeKey: "bot", path: root }),
      id: "listing",
    });
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ id: "listing", type: "end" }));
    expect(frames).toContainEqual(
      expect.objectContaining({
        channel: "result",
        data: expect.arrayContaining([
          expect.objectContaining({ path: path.join(root, "allowed.txt") }),
        ]),
      }),
    );
    const outside = await mkdtemp(path.join(tmpdir(), "host-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "never transmitted");
    await symlink(outside, path.join(root, "escape"));
    await agent.receive({
      ...request({
        op: "computer.files.read",
        homeKey: "bot",
        path: path.join(root, "escape", "secret.txt"),
      }),
      id: "second",
    });
    await vi.waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        id: "second",
        type: "end",
        problem: { code: "runtime-unavailable" },
      }),
    );
    expect(JSON.stringify(frames)).not.toContain("never transmitted");
  });
  it("keeps homes separate when space and computer identifiers contain separators", async () => {
    const { agent, frames } = await fixture();
    const write = request({
      op: "computer.files.write",
      homeKey: "c",
      path: "private.txt",
      content: Buffer.from("private file").toString("base64"),
    });
    await agent.receive({ ...write, scope: { ...write.scope, spaceId: "a-b" } });
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ type: "end", id: "req" }));
    expect(frames.at(-1)).not.toHaveProperty("problem");
    const read = request({ op: "computer.files.read", homeKey: "b-c", path: "private.txt" });
    await agent.receive({ ...read, id: "foreign", scope: { ...read.scope, spaceId: "a" } });
    await vi.waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        type: "end",
        id: "foreign",
        problem: { code: "runtime-unavailable" },
      }),
    );
    expect(frames.some((frame) => frame.type === "stream" && frame.channel === "file")).toBe(false);
  });
});

it("reports the host inventory through health and the run-scoped environment operation", async () => {
  const { agent, frames } = await fixture();
  const health = await agent.health();
  expect(health.environment?.tools[0]).toMatchObject({ name: "gh", status: "signed in" });
  await agent.receive(request({ op: "computer.environment", homeKey: "bot" }));
  await vi.waitFor(() => expect(frames.at(-1)?.type).toBe("end"));
  expect(frames[0]).toMatchObject({ type: "stream", channel: "result", data: health.environment });
});
