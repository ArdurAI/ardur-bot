import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ardurbot/host-runtime/runtimes/ardur-mcp-server", () => ({
  startArdurMcpServer: async () => ({ config: { command: "node", args: [] }, close: vi.fn() }),
}));
vi.mock("@ardurbot/host-runtime/runtimes/native-process", async (original) => ({
  ...(await original<object>()),
  findNativeBinary: async () => "/fake/claude",
}));

import { ClaudeCodeRuntime, probeClaude } from "./claude-code-runtime.js";

function probeProcess(output: string, code = 0) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    final(done) {
      done();
      setImmediate(() => {
        stdout.end(output);
        child.emit("close", code);
      });
    },
  });
  Object.assign(child, { stdin, stdout, stderr, kill: vi.fn() });
  return child;
}

function fixture(
  exitCode = 0,
  resume = false,
  options: {
    effort?: string;
    version?: string;
    init?: Record<string, unknown>;
    result?: Record<string, unknown>;
  } = {},
) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = "";
  const stdin = new Writable({
    write(chunk, _, done) {
      input += String(chunk);
      done();
    },
    final(done) {
      const events = [
        {
          type: "system",
          subtype: "init",
          model: "claude-opus-5",
          tools: [],
          session_id: "session",
          ...options.init,
        },
        {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
        },
        { type: "assistant", message: { model: "claude-opus-5" } },
        {
          type: "result",
          subtype: "success",
          modelUsage: { "claude-opus-5": {} },
          ...options.result,
        },
      ];
      stdout.end(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      done();
      queueMicrotask(() => {
        Object.assign(child, { exitCode });
        child.emit("close", exitCode);
      });
    },
  });
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      stdout.end();
      Object.assign(child, { signalCode: "SIGTERM" });
      queueMicrotask(() => child.emit("close", 0));
      return true;
    }),
  });
  const spawn = vi.fn((_binary: string, args: string[], _cwd?: string) =>
    args[0] === "--version" ? probeProcess(`${options.version ?? "2.1.281"}\n`) : child,
  );
  const info = vi.fn();
  const request: AgentRunRequest = {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Hello",
    instructions: "Instructions and memory",
    history: [],
    tools: [],
    onRuntimeInfo: info,
    nativeSession: resume
      ? { runtimeKind: "claude-code", sessionId: "session", effortAttested: true }
      : undefined,
    model: {
      provider: "anthropic",
      id: "claude-opus-5",
      runtimePin: {
        runtimeKind: "claude-code",
        provider: "anthropic",
        modelId: "claude-opus-5",
        effort: options.effort ?? "low",
        credentialId: "native:claude-code",
        revision: 1,
      },
    },
  };
  return {
    spawn,
    info,
    child,
    input: () => input,
    run: async () => {
      const events: AgentRuntimeEvent[] = [];
      for await (const event of new ClaudeCodeRuntime(spawn).run(request)) events.push(event);
      return events;
    },
  };
}
describe("Claude subprocess lifecycle", () => {
  it.each([0, 1])(
    "probes sign-in using auth status exit code %s and discards its output",
    async (authCode) => {
      const start = vi.fn((_binary: string, args: string[]) => {
        return probeProcess(
          args[0] === "--version" ? "2.1.281\n" : "fake-private-auth-output\n",
          args[0] === "--version" ? 0 : authCode,
        );
      });
      const status = await probeClaude(start);
      expect(start.mock.calls.map((call) => call[1])).toEqual([["--version"], ["auth", "status"]]);
      expect(status.available).toBe(authCode === 0);
      expect(status.version).toBe("2.1.281");
      expect(status.models.find((model) => model.id === "claude-opus-5")?.efforts).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      expect(JSON.stringify(status)).not.toContain("fake-private-auth-output");
      if (authCode === 1)
        expect(status.reason).toBe("Not signed in — run `claude` in a terminal once");
    },
  );
  it("streams a fake process, records its session and resumes only that session", async () => {
    const f = fixture(0, true);
    expect(await f.run()).toEqual([{ type: "text", text: "Hello" }, { type: "done" }]);
    expect(f.spawn.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining([
        "--resume",
        "session",
        "--model",
        "claude-opus-5",
        "--effort",
        "low",
      ]),
    );
    expect(f.input()).toContain('"role":"user"');
    expect(f.info).toHaveBeenLastCalledWith({
      runtimeKind: "claude-code",
      version: "2.1.281",
      sessionId: "session",
      effortAttested: false,
      effortAttestationReason: "Claude Code does not report the applied effort",
    });
  });
  it("does not accept a success record followed by a failing process", async () => {
    await expect(fixture(1).run()).rejects.toMatchObject({
      problem: { code: "runtime-unavailable" },
    });
  });
  it("still ends the process when persisting a mismatch fails", async () => {
    const f = fixture(0, false, { effort: "high", result: { effort: "low" } });
    f.info.mockImplementation(async (info) => {
      if (info.effortAttestationReason === "This runtime cannot attest the pinned effort.")
        throw new Error("private persistence detail");
    });
    await expect(f.run()).rejects.toMatchObject({ problem: { code: "runtime-unavailable" } });
  });
  it.each([false, true])(
    "passes every documented effort without translation, resume=%s",
    async (resume) => {
      for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
        const f = fixture(0, resume, { effort });
        expect(await f.run()).toContainEqual({ type: "done" });
        const args = f.spawn.mock.calls[1]![1];
        expect(args[args.indexOf("--effort") + 1]).toBe(effort);
        expect(args).toContain(resume ? "--resume" : "--session-id");
        expect(f.info.mock.calls[0]![0]).toMatchObject({ effortAttested: false });
        expect(f.info).toHaveBeenLastCalledWith(
          expect.objectContaining({
            effortAttested: false,
            effortAttestationReason: "Claude Code does not report the applied effort",
          }),
        );
      }
    },
  );
  it.each(["init", "result"])("records explicit effort evidence from %s", async (message) => {
    const f = fixture(0, false, { effort: "high", [message]: { effort: "high" } });
    expect(await f.run()).toContainEqual({ type: "done" });
    expect(f.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ effortAttested: true, effortAttestationReason: null }),
    );
  });
  it.each(["init", "result"])("fails closed on a %s effort mismatch", async (message) => {
    const f = fixture(0, false, { effort: "high", [message]: { effort: "low" } });
    await expect(f.run()).rejects.toMatchObject({
      problem: { code: "pin-effort-unsupported", pin: { effort: "high" } },
    });
    expect(f.info).toHaveBeenLastCalledWith(expect.objectContaining({ effortAttested: false }));
  });
  it.each(["off", "minimal", "ultracode", "unknown"])(
    "refuses unsupported effort %s before starting a turn",
    async (effort) => {
      const f = fixture(0, false, { effort });
      await expect(f.run()).rejects.toMatchObject({ problem: { code: "pin-effort-unsupported" } });
      expect(f.spawn.mock.calls.map((call) => call[1])).toEqual([["--version"]]);
    },
  );
  it.each(["2.1.258", "2.2.0", "3.0.0", "2.1.281-beta.1"])(
    "retains low only and blocks an unverified runtime %s",
    async (version) => {
      const start = vi.fn(() => probeProcess(version));
      const status = await probeClaude(start);
      expect(status.available).toBe(false);
      expect(status.models.every((model) => JSON.stringify(model.efforts) === '["low"]')).toBe(
        true,
      );
      expect(start).toHaveBeenCalledOnce();
      await expect(fixture(0, false, { version, effort: "high" }).run()).rejects.toMatchObject({
        problem: { code: "runtime-unavailable" },
      });
    },
  );
  it("falls back to low outside the checked effort range without clamping a high pin", async () => {
    const status = await probeClaude(() => probeProcess("2.1.282"));
    expect(status.available).toBe(true);
    expect(status.models.every((model) => JSON.stringify(model.efforts) === '["low"]')).toBe(true);
    await expect(
      fixture(0, false, { version: "2.1.282", effort: "high" }).run(),
    ).rejects.toMatchObject({ problem: { code: "pin-effort-unsupported" } });
    expect(await fixture(0, false, { version: "2.1.282" }).run()).toContainEqual({ type: "done" });
  });
});
