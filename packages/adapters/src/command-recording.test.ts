import { randomUUID } from "node:crypto";
import type { ProcessEvent, SandboxProvider } from "@ardurbot/adapter-kit";
import type { CommandBlock } from "@ardurbot/contracts";
import { COMMAND_OUTPUT_LIMIT, COMMAND_SUPPRESSED, COMMAND_TRUNCATED } from "@ardurbot/contracts";
import { projectCommandBlocks } from "@ardurbot/core";
import type { AppendEventInput, ThreadEvents } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import { adoptOpenCommands, createCommandRecording } from "./command-recording.js";

function fixture(
  output: ProcessEvent[] = [{ type: "exit", code: 7 }],
  secrets: string[] = [],
  resolveCwd?: (requested: string | undefined, executionId: string) => string | undefined,
  resume: Pick<
    Parameters<typeof createCommandRecording>[0],
    "openCommands" | "finishedCommands"
  > = {},
) {
  const events: AppendEventInput[] = [];
  const order: string[] = [];
  const abort = new AbortController();
  const append = vi.fn(async (event: AppendEventInput) => {
    events.push(structuredClone(event));
    order.push(event.type);
  });
  const sandbox = {
    resolveCommandCwd: vi.fn(async () => "/workspace/project"),
    execute: vi.fn(async function* () {
      order.push("execute");
      yield* output;
    }),
  } as unknown as SandboxProvider;
  const recording = createCommandRecording({
    events: { append } as unknown as ThreadEvents,
    sandbox,
    storedComputer: {
      id: "computer-1",
      scope: "team",
      homeKey: "team-space-1",
      kind: "docker",
      providerRef: "container-1",
    },
    computer: { id: "container-1", botId: "bot-1", kind: "docker", providerRef: "container-1" },
    context: {
      operationId: "run-1",
      traceId: "run-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      runId: "run-1",
      signal: abort.signal,
    },
    threadId: "thread-1",
    attemptId: "attempt-1",
    secrets,
    resolveCwd,
    ...resume,
  });
  const execute = () =>
    recording.execute("execution-1", ["bash", "-c", "pnpm test"], "project", {});
  const invoke = (command = "pnpm test") =>
    recording.invoke("shell", { command, cwd: "project" }, "execution-1", execute);
  const blocks = () =>
    projectCommandBlocks(
      events.map((event, seq) => ({ ...event, id: String(seq), seq, createdAt: new Date() })),
    );
  return { events, order, append, recording, execute, invoke, blocks, sandbox, abort };
}

describe("command recording boundary", () => {
  it("persists launch intent before execution and captures resolved cwd and exit", async () => {
    const f = fixture([
      { type: "stdout", data: "ok" },
      { type: "exit", code: 7 },
    ]);
    await f.invoke();
    expect(f.order).toEqual(["command.intent", "command.started", "execute", "command.finished"]);
    expect(f.blocks()[0]).toMatchObject({
      command: "pnpm test",
      cwd: "/workspace/project",
      attemptId: "attempt-1",
      executionId: "execution-1",
      exitCode: 7,
      stdout: "ok",
      outcome: "completed",
    });
  });
  it("executes a duplicate delivery only once", async () => {
    const f = fixture();
    await Promise.all([f.invoke(), f.invoke()]);
    expect(f.sandbox.execute).toHaveBeenCalledOnce();
    expect(f.events).toHaveLength(3);
  });
  it("fails closed when intent cannot be persisted", async () => {
    const f = fixture();
    f.append.mockRejectedValueOnce(new Error("store unavailable"));
    await expect(f.invoke()).rejects.toThrow();
    expect(f.sandbox.execute).not.toHaveBeenCalled();
  });
  it("redacts split secrets, structured credentials and terminal controls before any write", async () => {
    const secret = randomUUID();
    const f = fixture(
      [
        { type: "stdout", data: secret.slice(0, 10) },
        { type: "stdout", data: secret.slice(10) },
        { type: "stderr", data: `password=${secret}` },
        { type: "exit", code: 0 },
      ],
      [secret],
    );
    await f.invoke();
    expect(JSON.stringify(f.events)).not.toContain(secret);
    expect(f.blocks()[0]?.stdout).toBe("[redacted]");
    expect(f.blocks()[0]?.redacted).toBe(true);
  });
  it("never persists or executes a secret-bearing command or cwd", async () => {
    const secret = randomUUID();
    const f = fixture([], [secret]);
    await f.invoke(`echo ${secret}`);
    expect(JSON.stringify(f.events)).not.toContain(secret);
    expect(f.sandbox.execute).not.toHaveBeenCalled();
    expect(f.blocks()[0]?.rerunDisabledReason).toContain("safely");
    const cwd = fixture([], [secret]);
    await cwd.recording.invoke(
      "shell",
      { command: "pwd", cwd: secret },
      "execution-1",
      cwd.execute,
    );
    expect(JSON.stringify(cwd.events)).not.toContain(secret);
    expect(cwd.sandbox.execute).not.toHaveBeenCalled();
  });
  it("strips active controls and masks structured credentials even when not registered", async () => {
    const credential = randomUUID();
    const f = fixture([
      { type: "stdout", data: `\u001b]52;c;ignored\u0007password=${credential}\n\u001b[31mplain` },
      { type: "exit", code: 0 },
    ]);
    await f.invoke();
    expect(JSON.stringify(f.events)).not.toContain(credential);
    expect(f.blocks()[0]?.stdout).toBe("password=[Redacted]\nplain");
  });
  it("does not persist provider exceptions and rejects changed approval arguments", async () => {
    const credential = randomUUID();
    const f = fixture([], [credential]);
    await expect(
      f.recording.invoke("shell", { command: "pwd" }, "execution-1", async () => {
        expect(f.recording.matchesRequest("execution-1", { command: "other" })).toBe(false);
        throw new Error(credential);
      }),
    ).rejects.toThrow("complete recording");
    expect(JSON.stringify(f.events)).not.toContain(credential);
    expect(f.blocks()[0]?.outcome).toBe("unknown");
  });
  it("retains a previously completed effect without claiming it executed again", async () => {
    const f = fixture();
    await f.recording.invoke("shell", { command: "pwd" }, "execution-1", async () => ({
      stdout: "/workspace",
      stderr: "",
      code: 0,
    }));
    expect(f.blocks()[0]).toMatchObject({ outcome: "completed", durationMs: null, exitCode: 0 });
    expect(f.sandbox.execute).not.toHaveBeenCalled();
  });
  it("suppresses sensitive output and bounds retained output at the executor", async () => {
    const f = fixture([
      { type: "stdout", data: "x".repeat(COMMAND_OUTPUT_LIMIT * 20) },
      { type: "exit", code: 0 },
    ]);
    await f.invoke();
    expect(f.blocks()[0]?.stdout?.length).toBeLessThan(COMMAND_OUTPUT_LIMIT + 40);
    expect(f.blocks()[0]?.truncated).toBe(true);
    expect(f.blocks()[0]?.stdout).toContain(COMMAND_TRUNCATED);
    const sensitive = fixture([
      { type: "stdout", data: randomUUID() },
      { type: "exit", code: 0 },
    ]);
    await sensitive.invoke("printenv");
    expect(sensitive.blocks()[0]?.stdout).toBe(COMMAND_SUPPRESSED);
  });
  it("records waiting approval, cancellation, and missing exits honestly", async () => {
    const waiting = fixture();
    await waiting.recording.invoke("shell", { command: "pnpm test" }, "execution-1", async () =>
      approvalPausedToolResult(),
    );
    expect(waiting.events).toHaveLength(1);
    expect(waiting.events[0]?.payload.block).toMatchObject({ outcome: "waiting" });
    const missing = fixture([{ type: "stdout", data: "partial" }]);
    await missing.invoke();
    expect(missing.blocks()[0]?.outcome).toBe("unknown");
    const cancelled = fixture();
    cancelled.abort.abort();
    await expect(cancelled.invoke()).rejects.toThrow();
    expect(cancelled.blocks()[0]?.outcome).toBe("cancelled");
    expect(cancelled.sandbox.execute).not.toHaveBeenCalled();
  });
  it("does not record cancelled when stopping the command times out", async () => {
    const f = fixture();
    f.sandbox.execute = vi.fn(async function* () {
      f.abort.abort();
      yield { type: "stdout" as const, data: "" };
      const error = new Error("The command's cancellation timed out, so its outcome is uncertain.");
      Object.assign(error, { uncertain: true });
      throw error;
    });
    await expect(f.invoke()).rejects.toThrow(
      "The command's cancellation timed out, so its outcome is uncertain.",
    );
    expect(f.blocks()[0]?.outcome).toBe("unknown");
    expect(f.blocks()[0]?.error).toBe(
      "The command's cancellation timed out, so its outcome is uncertain.",
    );
  });
});

describe("a call resuming after a killed attempt", () => {
  const earlier = (overrides: Partial<CommandBlock>): CommandBlock => ({
    commandId: "card-earlier",
    runId: "run-1",
    attemptId: "attempt-0",
    executionId: "execution-1",
    command: "pnpm test",
    cwd: "/workspace/project",
    computerId: "computer-1",
    computer: "docker:container-1",
    startedAt: "2026-09-23T12:00:00.000Z",
    durationMs: null,
    exitCode: null,
    outcome: "running",
    stdout: null,
    stderr: null,
    error: null,
    redacted: false,
    truncated: false,
    replayOf: null,
    rerunDisabledReason: null,
    ...overrides,
  });
  it("adopts only waiting or running cards of calls that did not finish", () => {
    const open = new Map<string, CommandBlock>();
    adoptOpenCommands(
      open,
      [
        { type: "command.intent", payload: { block: earlier({ outcome: "waiting" }) } },
        {
          type: "command.started",
          payload: { block: earlier({ commandId: "card-2", executionId: "execution-2" }) },
        },
        {
          type: "command.intent",
          payload: { block: earlier({ commandId: "card-3", executionId: "execution-3" }) },
        },
        { type: "agent.tool.called", payload: { name: "shell", executionId: "execution-4" } },
      ],
      new Set(["execution-3"]),
    );
    expect([...open.keys()]).toEqual(["execution-1", "execution-2"]);
  });
  it("finishes the same call's card under this attempt and keeps its start", async () => {
    const f = fixture([{ type: "exit", code: 0 }], [], undefined, {
      openCommands: new Map([["execution-1", earlier({})]]),
    });
    await f.invoke();
    expect(f.order).toEqual(["command.started", "execute", "command.finished"]);
    expect(f.blocks()).toEqual([
      expect.objectContaining({
        commandId: "card-earlier",
        attemptId: "attempt-1",
        startedAt: "2026-09-23T12:00:00.000Z",
        outcome: "completed",
      }),
    ]);
  });
  it("returns a finished call's recorded result without a second card and never runs it", async () => {
    const recorded = { stdout: "ok", stderr: "", code: 0 };
    const replayed = fixture(undefined, [], undefined, {
      finishedCommands: new Set(["execution-1"]),
    });
    await expect(
      replayed.recording.invoke(
        "shell",
        { command: "pnpm test" },
        "execution-1",
        async () => recorded,
      ),
    ).resolves.toBe(recorded);
    expect(replayed.events).toEqual([]);
    const refused = fixture(undefined, [], undefined, {
      finishedCommands: new Set(["execution-1"]),
    });
    await expect(refused.invoke()).rejects.toThrow("already finished in an earlier attempt");
    expect(refused.sandbox.execute).not.toHaveBeenCalled();
    expect(refused.events).toEqual([]);
  });
});

it("records the task-owned working directory selected for a helper execution", async () => {
  const resolveCwd = vi.fn(() => "tasks/root/helper/project");
  const f = fixture(undefined, [], resolveCwd);
  await f.invoke();
  expect(resolveCwd).toHaveBeenCalledWith("project", "execution-1");
  expect(f.sandbox.resolveCommandCwd).toHaveBeenCalledWith(
    expect.anything(),
    "tasks/root/helper/project",
    expect.anything(),
  );
});
