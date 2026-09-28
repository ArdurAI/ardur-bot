import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import type { HostFrame, HostOperation, HostRequest } from "@ardurbot/contracts/host-bridge";
import {
  decodeHostFrame,
  encodeHostFrame,
  HOST_WINDOW,
  HostHealthSchema,
  negotiateHostHealth,
} from "@ardurbot/contracts/host-bridge";
import { HermesExecutionEnvelopeSchema } from "@ardurbot/contracts/runtime-config";
import { RuntimePinError, runtimePinProblem } from "@ardurbot/contracts/runtime-pins";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import profileFixture from "../python/tests/valid_profile.json" with { type: "json" };
import { BoardRunner } from "./board/runner.js";
import type { HostWire } from "./bridge-wire.js";
import { wsWire } from "./bridge-wire.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { HostAgent } from "./host-agent.js";
import { HostMcpServers } from "./host-mcp.js";
import { createLocalImportScanner, LocalImportScanner } from "./import/scanner.js";
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
vi.mock("./import/scanner.js", async (original) => ({
  ...(await original<object>()),
  createLocalImportScanner: vi.fn(),
}));
const agents: HostAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) agent.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it.skipIf(process.platform === "win32")(
  "reports a missing managed Hermes install without searching elsewhere",
  async () => {
    vi.stubEnv("ARDUR_HERMES_INSTALL", "");
    const { agent } = await fixture();
    expect((await agent.health()).hermes).toMatchObject({
      available: false,
      reasonId: "install-missing",
      reason: "Hermes is not installed on this computer.",
    });
  },
);
it.skipIf(process.platform === "win32")(
  "refuses a managed Hermes project with a dotenv file",
  async () => {
    vi.stubEnv("ARDUR_HERMES_INSTALL", "");
    const data = await mkdtemp(path.join(tmpdir(), "hermes-managed-host-"));
    roots.push(data);
    const root = path.join(data, "workspaces");
    const managed = path.join(data, "runtimes", "hermes-agent");
    await mkdir(path.join(managed, ".venv", "bin"), { recursive: true });
    await writeFile(path.join(managed, ".venv", "bin", "python"), "fixture");
    await writeFile(path.join(managed, ".env"), "");
    const agent = new HostAgent(
      { root, hostRoots: [root] },
      { send: async () => undefined, close: vi.fn() },
    );
    agents.push(agent);
    await agent.initialize();
    expect((await agent.health()).hermes).toMatchObject({
      available: false,
      reasonId: "install-invalid",
      reason: "Hermes is not installed on this computer.",
    });
  },
);
it("streams board JSON from the owner's runner without provisioning a bot computer", async () => {
  const stdout = JSON.stringify([{ title: "x".repeat(60_000) }]);
  const run = vi.spyOn(BoardRunner.prototype, "run").mockResolvedValue({ ok: true, stdout });
  const provision = vi.spyOn(DesktopSandboxProvider.prototype, "provision");
  const { agent, frames } = await fixture();
  const board = {
    action: "command" as const,
    actor: "Owner",
    workspace: { kind: "space" as const },
    argv: ["ready"],
  };
  await agent.receive(request({ op: "board.run", request: board }));
  await vi.waitFor(() => expect(frames.at(-1)?.type).toBe("end"));
  expect(run).toHaveBeenCalledWith(board, "space", expect.any(AbortSignal));
  expect(provision).not.toHaveBeenCalled();
  expect(
    frames
      .filter((frame) => frame.type === "stream" && frame.channel === "stdout")
      .map((frame) => (frame.type === "stream" ? frame.data : ""))
      .join(""),
  ).toBe(stdout);
  expect(frames).toContainEqual(expect.objectContaining({ channel: "result", data: { ok: true } }));
});
it("keeps ordinary host operations available to a server with the pre-relay strict health schema", async () => {
  const { agent, frames, completed } = await fixture();
  const oldStrictHealth = HostHealthSchema.omit({
    generation: true,
    capabilities: true,
    hermes: true,
  });
  const health = negotiateHostHealth(await agent.health(), undefined);
  const sentHealth = JSON.parse(JSON.stringify(health));
  expect(oldStrictHealth.parse(sentHealth)).toEqual(sentHealth);
  const runner = vi.spyOn(BoardRunner.prototype, "run").mockResolvedValue({
    ok: true,
    stdout: "ready",
  });
  const board: HostOperation = {
    op: "board.run",
    request: { action: "command", actor: "Owner", workspace: { kind: "space" }, argv: ["ready"] },
  };
  await agent.receive(request(board));
  await completed("req");
  expect(runner).toHaveBeenCalledOnce();
  expect(frames).toContainEqual(expect.objectContaining({ channel: "result", data: { ok: true } }));
  agent.setAcceptedHealth("providerRelay,hermes");
  await agent.receive({ ...request({ op: "host.health" }), id: "refresh" });
  await completed("refresh");
  const refreshed = frames.findLast(
    (frame) => frame.type === "stream" && frame.channel === "result",
  );
  expect(refreshed?.type === "stream" ? HostHealthSchema.parse(refreshed.data) : null).toBeTruthy();
  const oldRelayHealth = HostHealthSchema.extend({
    capabilities: HostHealthSchema.shape.capabilities.unwrap().pick({ providerRelay: true }),
  });
  expect(refreshed?.type === "stream" ? oldRelayHealth.parse(refreshed.data) : null).toBeTruthy();
});

it.each([undefined, "providerRelay,hermes"])(
  "negotiates requested health for acceptance %s",
  async (advertisement) => {
    const { agent, frames, completed } = await fixture();
    agent.setAcceptedHealth(advertisement);
    await agent.receive(request({ op: "host.health", refreshSignIn: true }));
    await completed("req");
    const result = frames.find((frame) => frame.type === "stream" && frame.channel === "result");
    if (result?.type !== "stream") throw new Error("Missing health result");
    expect(HostHealthSchema.parse(result.data).capabilities).toEqual(
      advertisement ? { providerRelay: 1 } : undefined,
    );
  },
);
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
async function fixture(runtime?: AgentRuntime, acknowledge = false, wire?: HostWire) {
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
    wire ?? {
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
  it("rejects a forged B12 manifest before any provider or tool callback", async () => {
    const { agent, frames, completed } = await fixture();
    const envelope = HermesExecutionEnvelopeSchema.parse(profileFixture);
    const operation: HostOperation = {
      ...turn,
      request: {
        ...turn.request,
        executionEnvelope: { ...envelope, effectiveRuntimeConfigHash: "0".repeat(64) },
        providerBroker: {
          protocol: 1,
          id: crypto.randomUUID(),
          token: "a".repeat(43),
          expiresAt: Date.now() + 60_000,
          hostGeneration: crypto.randomUUID(),
        },
        model: {
          provider: "fixture",
          id: "fixture-model",
          contextWindow: 32_768,
          maxTokens: 1_024,
          reasoning: true,
          acceptsImages: false,
          thinkingLevel: "high",
          runtimePin: {
            runtimeKind: "hermes",
            provider: "fixture",
            modelId: "fixture-model",
            effort: "high",
            credentialId: "fixture-connection",
            revision: 1,
            runtimeConfigHash: envelope.runtimeConfigHash,
          },
        },
      },
    };
    await agent.receive(request(operation));
    await completed("req");
    expect(frames.at(-1)).toMatchObject({ type: "end", problem: expect.any(Object) });
    expect(frames.filter((frame) => frame.type === "callback")).toHaveLength(0);
  });
  it("sends a Hermes failure on the real wire and keeps the host available for another operation", async () => {
    const frames: HostFrame[] = [];
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      bufferedAmount: 0,
      close: vi.fn(),
      send: vi.fn((data: string, callback: () => void) => {
        frames.push(decodeHostFrame(data));
        callback();
      }),
    });
    const { agent } = await fixture(undefined, false, wsWire(socket as unknown as WebSocket));
    const hermes = {
      ...turn,
      request: {
        ...turn.request,
        model: {
          ...turn.request.model,
          runtimePin: {
            ...turn.request.model.runtimePin,
            runtimeKind: "hermes" as const,
          },
        },
      },
    } satisfies HostOperation;
    await agent.receive(request(hermes));
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "end",
          id: "req",
          problem: expect.objectContaining({
            pin: expect.objectContaining({ runtimeKind: "hermes" }),
          }),
        }),
      ),
    );
    const runner = vi
      .spyOn(BoardRunner.prototype, "run")
      .mockResolvedValue({ ok: true, stdout: "" });
    const board: HostOperation = {
      op: "board.run",
      request: { action: "command", actor: "Owner", workspace: { kind: "space" }, argv: ["ready"] },
    };
    await agent.receive({
      ...request(board),
      id: "next",
    });
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ type: "end", id: "next" }));
    runner.mockRejectedValueOnce(
      new RuntimePinError(
        runtimePinProblem(
          { ...turn.request.model.runtimePin, runtimeKind: "claude-code" },
          "runtime-unavailable",
          "x".repeat(256 * 1024),
        ),
      ),
    );
    await agent.receive({ ...request(board), id: "oversized-error" });
    await vi.waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        type: "end",
        id: "oversized-error",
        problem: { reason: "Host operation could not finish." },
      }),
    );
    await agent.receive({ ...request(board), id: "after-error" });
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ type: "end", id: "after-error" }));
    expect(socket.close).not.toHaveBeenCalled();
  });
  it("streams a metadata manifest in bounded frames and reads a scanned item without provisioning a computer", async () => {
    const { agent, frames, root: home, completed } = await fixture(undefined, true);
    const folder = path.join(home, ".claude/projects/fixture/memory");
    await mkdir(folder, { recursive: true });
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(path.join(folder, `fact-${index}.md`), "A fixture note."),
      ),
    );
    const scanner = new LocalImportScanner({ home, platform: "darwin" });
    vi.mocked(createLocalImportScanner).mockResolvedValueOnce(scanner);
    const provision = vi.spyOn(DesktopSandboxProvider.prototype, "provision");
    await agent.receive(request({ op: "import.scan" }));
    await completed("req");
    expect(frames.at(-1)).toEqual({ v: 1, type: "end", id: "req" });
    const chunks = frames.flatMap((frame) => (frame.type === "stream" ? [String(frame.data)] : []));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 24 * 1024)).toBe(true);
    const manifest = JSON.parse(chunks.join(""));
    expect(manifest.items).toHaveLength(100);
    expect(chunks.join("")).not.toContain("A fixture note.");
    expect(provision).not.toHaveBeenCalled();
    frames.splice(0);
    await agent.receive({
      ...request({ op: "import.read", scanId: manifest.scanId, itemId: manifest.items[0].id }),
      id: "read-request",
    });
    await completed("read-request");
    expect(frames.at(-1)).toEqual({ v: 1, type: "end", id: "read-request" });
    const body = JSON.parse(
      frames.flatMap((frame) => (frame.type === "stream" ? [String(frame.data)] : [])).join(""),
    );
    expect(body.content).toBe("A fixture note.");
    expect(provision).not.toHaveBeenCalled();
  });
  it("reports a stale scan as a distinct rescan problem, not a lost host", async () => {
    const { agent, frames, root: home, completed } = await fixture();
    const scanner = new LocalImportScanner({ home, platform: "darwin" });
    vi.mocked(createLocalImportScanner).mockResolvedValueOnce(scanner);
    // No scan has run yet, so any scanId is stale: the reviewer's own reproduction.
    await agent.receive(
      request({
        op: "import.read",
        scanId: "00000000-0000-4000-8000-000000000000",
        itemId: "00000000-0000-4000-8000-000000000001",
      }),
    );
    await completed("req");
    expect(frames.at(-1)).toMatchObject({
      type: "end",
      id: "req",
      problem: { code: "local-import-rescan" },
    });
  });
  it("reports an unavailable item as a distinct per-item problem, not a lost host", async () => {
    const { agent, frames, root: home, completed } = await fixture();
    const folder = path.join(home, ".claude/projects/fixture/memory");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "fact.md"), "A fixture note.");
    const scanner = new LocalImportScanner({ home, platform: "darwin" });
    vi.mocked(createLocalImportScanner).mockResolvedValueOnce(scanner);
    await agent.receive(request({ op: "import.scan" }));
    await completed("req");
    const manifest = JSON.parse(
      frames.flatMap((frame) => (frame.type === "stream" ? [String(frame.data)] : [])).join(""),
    );
    frames.splice(0);
    // The scan is current, but this itemId was never in it.
    await agent.receive({
      ...request({
        op: "import.read",
        scanId: manifest.scanId,
        itemId: "00000000-0000-4000-8000-000000000099",
      }),
      id: "read-request",
    });
    await completed("read-request");
    expect(frames.at(-1)).toMatchObject({
      type: "end",
      id: "read-request",
      problem: { code: "local-import-item" },
    });
  });
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
