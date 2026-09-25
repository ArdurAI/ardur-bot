import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import type { HostFrame, HostOperation, HostRequest } from "@ardurbot/contracts/host-bridge";
import { decodeHostFrame, encodeHostFrame, HOST_WINDOW } from "@ardurbot/contracts/host-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { HostAgent } from "./host-agent.js";
import { HostMcpServers } from "./host-mcp.js";
import { nativeEnvironment } from "./runtimes/native-process.js";

vi.mock("node:os", async (original) => ({
  ...(await original<object>()),
  hostname: () => "Test computer",
}));
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
async function fixture(runtime?: AgentRuntime, acknowledge = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "host-agent-")));
  roots.push(root);
  const frames: HostFrame[] = [];
  const pendingEnds = new Map<string, () => void>();
  function completed(id: string) {
    if (frames.some((frame) => frame.type === "end" && frame.id === id)) return Promise.resolve();
    return new Promise<void>((resolve) => pendingEnds.set(id, resolve));
  }
  const agent = new HostAgent(
    { root, hostRoots: [root] },
    {
      send: async (frame) => {
        frames.push(decodeHostFrame(encodeHostFrame(frame)));
        if (acknowledge && frame.type === "stream")
          queueMicrotask(() => {
            void agent.receive({ v: 1, type: "ack", id: frame.id, seq: frame.seq });
          });
        if (frame.type === "end") {
          pendingEnds.get(frame.id)?.();
          pendingEnds.delete(frame.id);
        }
      },
      close: vi.fn(),
    },
    runtime ? { "claude-code": runtime, "codex-app-server": runtime } : undefined,
  );
  agents.push(agent);
  await agent.initialize();
  return { root, frames, agent, completed };
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
    const { agent, frames, root, completed } = await fixture();
    await writeFile(path.join(root, "allowed.txt"), "file contents");
    await agent.receive(
      request({ op: "computer.files.read", homeKey: "bot", path: path.join(root, "allowed.txt") }),
    );
    await completed("req");
    expect(frames.at(-1)).toMatchObject({ type: "end", id: "req" });
    expect(frames[0]).toMatchObject({
      channel: "file",
      data: Buffer.from("file contents").toString("base64"),
    });
    await agent.receive({
      ...request({ op: "computer.files.list", homeKey: "bot", path: root }),
      id: "listing",
    });
    await completed("listing");
    expect(frames.at(-1)).toMatchObject({ id: "listing", type: "end" });
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
    await completed("second");
    expect(frames.at(-1)).toMatchObject({
      id: "second",
      type: "end",
      problem: { code: "runtime-unavailable" },
    });
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
  expect(health.name).toBe("Test computer");
  expect(health.environment?.tools[0]).toMatchObject({ name: "gh", status: "signed in" });
  await agent.receive(request({ op: "computer.environment", homeKey: "bot" }));
  await vi.waitFor(() => expect(frames.at(-1)?.type).toBe("end"));
  expect(frames[0]).toMatchObject({ type: "stream", channel: "result", data: health.environment });
});

vi.mock("./host-integrations.js", () => ({ inspectHostIntegrations: async () => [] }));
it("round-trips a 2 MB owner save and bounds larger previews without raising bot file limits", async () => {
  const { agent, frames, root, completed } = await fixture(undefined, true);
  const content = Buffer.alloc(2 * 1024 * 1024, 97);
  const file = path.join(root, "editor.txt");
  await agent.receive(
    request({
      op: "computer.files.write",
      homeKey: "ide",
      path: file,
      editor: true,
      content: content.toString("base64"),
    }),
  );
  await completed("req");
  expect(frames.at(-1)).toMatchObject({ type: "end", id: "req" });
  expect(frames.at(-1)).not.toHaveProperty("problem");
  expect(await readFile(file)).toEqual(content);
  await writeFile(file, Buffer.concat([content, Buffer.from("large")]));
  await agent.receive({
    ...request({
      op: "computer.files.read",
      homeKey: "ide",
      path: file,
      editor: true,
      maxBytes: content.length + 1,
    }),
    id: "preview",
  });
  await completed("preview");
  expect(frames.at(-1)).toMatchObject({ type: "end", id: "preview" });
  const chunks = frames.flatMap((frame) =>
    frame.type === "stream" && frame.id === "preview" && frame.channel === "file"
      ? [Buffer.from(frame.data as string, "base64")]
      : [],
  );
  expect(Buffer.concat(chunks).length).toBe(content.length + 1);
  await agent.receive({
    ...request({ op: "computer.files.read", homeKey: "bot", path: file }),
    id: "bot-read",
  });
  await completed("bot-read");
  expect(frames.at(-1)).toMatchObject({
    type: "end",
    id: "bot-read",
    problem: expect.any(Object),
  });
});

it("dispatches registered MCP requests and completes acknowledged streams without provisioning files", async () => {
  const execute = vi.spyOn(HostMcpServers.prototype, "execute").mockResolvedValue({ tools: [] });
  const provision = vi.spyOn(DesktopSandboxProvider.prototype, "provision");
  const { agent, frames, root, completed } = await fixture(undefined, true);
  agent.refreshMcp = vi.fn(async () => {
    await agent.configureMcp([
      {
        serverId: "server",
        userId: "owner",
        spaceId: "space",
        revision: 1,
        command: "node",
        args: [],
        env: {},
        cwd: root,
        redactions: [],
      },
    ]);
  });
  const operation = { op: "mcp.tools", serverId: "server", revision: 1 } as const;
  const frame = request(operation);
  await agent.receive(frame);
  await completed(frame.id);
  expect(agent.refreshMcp).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledWith(operation, frame.scope, expect.any(AbortSignal));
  expect(provision).not.toHaveBeenCalled();
  expect(frames).toEqual([
    { v: 1, type: "stream", id: frame.id, seq: 0, channel: "result", data: { tools: [] } },
    { v: 1, type: "end", id: frame.id },
  ]);
});
