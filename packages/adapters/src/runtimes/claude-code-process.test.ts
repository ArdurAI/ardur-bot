import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ardur-mcp-server.js", () => ({
  startArdurMcpServer: async () => ({ config: { command: "node", args: [] }, close: vi.fn() }),
}));
vi.mock("./native-process.js", async (original) => ({
  ...(await original<object>()),
  findNativeBinary: async () => "/fake/claude",
}));

import { ClaudeCodeRuntime, probeClaude } from "./claude-code-runtime.js";

function fixture(exitCode = 0, resume = false) {
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
        },
        {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
        },
        { type: "result", subtype: "success", modelUsage: { "claude-opus-5": {} } },
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
  const spawn = vi.fn((_binary: string, _args: string[], _cwd?: string) => child);
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
    nativeSession: resume ? { runtimeKind: "claude-code", sessionId: "session" } : undefined,
    model: {
      provider: "anthropic",
      id: "claude-opus-5",
      runtimePin: {
        runtimeKind: "claude-code",
        provider: "anthropic",
        modelId: "claude-opus-5",
        effort: "low",
        credentialId: "native:claude-code",
        revision: 1,
      },
    },
  };
  return {
    spawn,
    info,
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
        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new Writable({
          final(done) {
            done();
            setImmediate(() => {
              stdout.end(args[0] === "--version" ? "2.1.281\n" : "fake-private-auth-output\n");
              child.emit("close", args[0] === "--version" ? 0 : authCode);
            });
          },
        });
        Object.assign(child, { stdin, stdout, stderr, kill: vi.fn() });
        return child;
      });
      const status = await probeClaude(start);
      expect(start.mock.calls.map((call) => call[1])).toEqual([["--version"], ["auth", "status"]]);
      expect(status.available).toBe(authCode === 0);
      expect(status.version).toBe("2.1.281");
      expect(JSON.stringify(status)).not.toContain("fake-private-auth-output");
      if (authCode === 1)
        expect(status.reason).toBe("Not signed in — run `claude` in a terminal once");
    },
  );
  it("streams a fake process, records its session and resumes only that session", async () => {
    const f = fixture(0, true);
    expect(await f.run()).toEqual([{ type: "text", text: "Hello" }, { type: "done" }]);
    expect(f.spawn.mock.calls[0]?.[1]).toEqual(
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
    expect(f.info).toHaveBeenCalledWith({ runtimeKind: "claude-code", sessionId: "session" });
  });
  it("does not accept a success record followed by a failing process", async () => {
    await expect(fixture(1).run()).rejects.toMatchObject({
      problem: { code: "runtime-unavailable" },
    });
  });
});
