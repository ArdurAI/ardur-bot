import { randomUUID } from "node:crypto";
import type { ProcessEvent, SandboxProvider } from "@ardurbot/adapter-kit";
import type { CommandBlock } from "@ardurbot/contracts";
import { COMMAND_OUTPUT_LIMIT, COMMAND_SUPPRESSED, COMMAND_TRUNCATED } from "@ardurbot/contracts";
import { projectCommandBlocks } from "@ardurbot/core";
import type { AppendEventInput, ThreadEvents } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import {
  adoptOpenCommands,
  createCommandRecording,
  sensitiveShellCommand,
} from "./command-recording.js";

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
    fence: 1,
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

describe("credential-read output suppression", () => {
  it.each([
    ["sh -c 'printenv'", true],
    ['sh -c "env"', true],
    ["sh -lc 'printenv'", true],
    ['sh -lc "env"', true],
    ["sh -ic 'printenv'", true],
    ['sh -ic "env"', true],
    ["bash -c 'printenv'", true],
    ['bash -c "env"', true],
    ["bash -lc 'printenv'", true],
    ['bash -lc "env"', true],
    ["bash -ic 'printenv'", true],
    ['bash -ic "env"', true],
    ["zsh -c 'printenv'", true],
    ['zsh -c "env"', true],
    ["zsh -lc 'printenv'", true],
    ['zsh -lc "env"', true],
    ["zsh -ic 'printenv'", true],
    ['zsh -ic "env"', true],
    ["dash -c 'printenv'", true],
    ['dash -c "env"', true],
    ["dash -lc 'printenv'", true],
    ['dash -lc "env"', true],
    ["dash -ic 'printenv'", true],
    ['dash -ic "env"', true],
    ["ksh -c 'printenv'", true],
    ['ksh -c "env"', true],
    ["ksh -lc 'printenv'", true],
    ['ksh -lc "env"', true],
    ["ksh -ic 'printenv'", true],
    ['ksh -ic "env"', true],
    ['zsh -c "set"', true],
    ["eval 'printenv'", true],
    ['eval "env"', true],
    ["xargs printenv", true],
    ["xargs node scripts/export-site.mjs", false],
    ["sudo printenv", true],
    ["sudo node scripts/export-site.mjs", false],
    ["doas printenv", true],
    ["doas node scripts/export-site.mjs", false],
    ["nohup printenv", true],
    ["nohup node scripts/export-site.mjs", false],
    ["time printenv", true],
    ["time node scripts/export-site.mjs", false],
    ["nice printenv", true],
    ["nice node scripts/export-site.mjs", false],
    ["exec printenv", true],
    ["exec node scripts/export-site.mjs", false],
    ["command printenv", true],
    ["command node scripts/export-site.mjs", false],
    ["builtin printenv", true],
    ["builtin node scripts/export-site.mjs", false],
    ["timeout 10 printenv", true],
    ["timeout 10 node scripts/export-site.mjs", false],
    ["env FOO=1 printenv", true],
    ["env FOO=1 node scripts/export-site.mjs", false],
    ["env printenv", true],
    ["env node scripts/export-site.mjs", false],
    ["sudo env", true],
    ["nohup env", true],
    ["time env", true],
    ["exec env", true],
    ["env FOO=1 BAR=2 env", true],
    ["sudo nohup bash -lc 'printenv'", true],
    ["/usr/bin/sudo /usr/bin/printenv", true],
    ["bash -c 'gh auth token'", true],
    ["eval 'git credential fill'", true],
    ["bash -c 'pnpm test'", false],
    ["sh -lc 'env FOO=1 node x.js'", false],
    ["zsh -c 'set -e; pnpm test'", false],
    ["eval 'echo printenv'", false],
    ['echo "bash -c printenv"', false],
    ["echo \"bash -c 'printenv'\"", false],
    ["xargs echo printenv", false],
    ["sudo gh auth status", false],
    ["sudo git credential-osxkeychain --help", false],
    ["gh auth token", true],
    ["git credential fill", true],
    ["git credential get", true],
    ["git credential-osxkeychain get", true],
    ["git credential-store get", true],
    ["git credential-cache get", true],
    ["gpg --export-secret-keys", true],
    ["gpg --armor --export-secret-subkeys fixture", true],
    ["security export -k fixture.keychain", true],
    ["aws configure export-credentials", true],
    ["aws sts get-session-token", true],
    ["aws sts assume-role --role-arn fixture", true],
    ["gcloud auth print-access-token", true],
    ["gcloud auth print-identity-token", true],
    ["az account get-access-token", true],
    ["vault read fixture/path", true],
    ["vault kv get fixture/path", true],
    ["vault token lookup", true],
    ["op read fixture/item", true],
    ["op item get fixture", true],
    ["kubectl get secret fixture", true],
    ["kubectl get secrets", true],
    ["/usr/bin/gh auth token", true],
    ['git commit -m "token refresh"', false],
    ["git log --grep credential", false],
    ['rg -n "export " packages/', false],
    ["pnpm exec vitest run packages/adapters/src/secret.test.ts", false],
    ["node scripts/export-site.mjs", false],
    ['echo "set -e"', false],
    ["cat docs/env-vars.md", false],
    ["gh pr view 131", false],
    ["gh auth status", false],
    ["git credential-osxkeychain --help", false],
    ["kubectl get pods", false],
    ["docker login --help", false],
    ["docker login", false],
    ["set -e; pnpm test", false],
    ["grep -n token src/a.ts", false],
    ["grep -n sensitiveShellCommand src/a.ts", false],
    ["printenv", true],
    ["/usr/bin/printenv", true],
    ["/usr/bin/env", true],
    ["env -0", true],
    ["env FOO=1", true],
    ["env -u FOO", true],
    ["export -p", true],
    ["env --help", false],
    ["/bin/cat .env", true],
    ["/usr/bin/security find-generic-password -s x", true],
    ["env", true],
    ["set", true],
    ["export", true],
    ["cat .env", true],
    ["cat project/.env.local", true],
    ["source .env", true],
    ["node x.js < .env", true],
    ["security find-generic-password -s x", true],
    ["security dump-keychain", true],
    ["security add-generic-password -s x", false],
    ["export FOO=1 && node x.js", false],
    // Assignments with a program set its environment; they do not print it.
    ["env FOO=1 node x.js", false],
    ["echo password token credential", false],
    ["cat fixture/.ssh/config", true],
    ["cat fixture/.aws/config", true],
    ["cat fixture/.kube/config", true],
    ["cat fixture/.gnupg/private-keys-v1.d/key", true],
    ["cat /proc/123/environ", true],
    ["pnpm test; printenv", true],
    ["pnpm test\nexport", true],
  ])("%s suppresses output: %s", (command, hidden) => {
    expect(sensitiveShellCommand(command)).toBe(hidden);
  });

  it.each([
    "gh auth token",
    "git credential fill",
    "gpg --export-secret-keys",
    "bash -c 'printenv'",
    "eval 'printenv'",
    "sudo env",
  ])("never retains opaque reader output for %s", async (command) => {
    const opaque = "fixture-unstructured-output";
    const f = fixture([
      { type: "stdout", data: opaque },
      { type: "stderr", data: opaque },
      { type: "exit", code: 0 },
    ]);
    const result = await f.invoke(command);
    expect(result).toMatchObject({ stdout: COMMAND_SUPPRESSED, stderr: COMMAND_SUPPRESSED });
    expect(JSON.stringify(f.events)).not.toContain(opaque);
    expect(f.blocks()[0]?.stdout).toBe(COMMAND_SUPPRESSED);
  });

  it.each([
    "set -e; pnpm test",
    "grep -n token src/a.ts",
    "export FOO=1 && node x.js",
    "env FOO=1 node x.js",
  ])("keeps ordinary output for %s", async (command) => {
    const f = fixture([
      { type: "stdout", data: "development output" },
      { type: "exit", code: 0 },
    ]);
    const result = await f.invoke(command);
    expect(result).toMatchObject({ stdout: "development output", code: 0 });
    expect(f.blocks()[0]?.stdout).toBe("development output");
  });
});

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
  it("runs credential-looking fixtures unchanged while retaining only redacted arguments", async () => {
    const fake = `sk-${"f".repeat(40)}`;
    const command = `echo ${fake}`;
    const f = fixture([
      { type: "stdout", data: `${fake} fixture output` },
      { type: "exit", code: 0 },
    ]);
    const tool = vi.fn(async (_name, args) => {
      expect(args.command).toBe(command);
      return f.execute();
    });
    const result = await f.recording.invoke("shell", { command }, "execution-1", tool);
    expect(tool).toHaveBeenCalledOnce();
    expect(f.sandbox.execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ stdout: "[Redacted] fixture output", code: 0 });
    expect(JSON.stringify(f.events)).not.toContain(fake);
    expect(f.blocks()[0]).toMatchObject({
      command: "echo [Redacted]",
      redacted: true,
      rerunDisabledReason: "This command cannot be retained safely for rerun.",
    });
    expect(f.events[0]?.payload.replay).toBeNull();
  });
  it("refuses a known value with the existing sentence before calling the tool", async () => {
    const known = "fixture-managed-value";
    const f = fixture([], [known]);
    const tool = vi.fn();
    const result = await f.recording.invoke(
      "shell",
      { command: `echo ${known}` },
      "execution-1",
      tool,
    );
    expect(result).toEqual({
      error:
        "This command was not run because its arguments could not be retained safely; use managed credential variables.",
    });
    expect(tool).not.toHaveBeenCalled();
    expect(JSON.stringify(f.events)).not.toContain(known);
  });
  it("runs a 40 KB command", async () => {
    const command = `echo ${"x".repeat(40 * 1024)}`;
    const f = fixture();
    const tool = vi.fn(async (_name, args) => {
      expect(args.command).toBe(command);
      return f.execute();
    });
    await f.recording.invoke("shell", { command }, "execution-1", tool);
    expect(tool).toHaveBeenCalledOnce();
    expect(f.blocks()[0]?.command).toBe(command);
  });
  it.each(["x".repeat(70 * 1024), "é".repeat(40 * 1024)])(
    "refuses commands over the byte limit with a clear reason",
    async (command) => {
      const f = fixture();
      const tool = vi.fn();
      const result = await f.recording.invoke("shell", { command }, "execution-1", tool);
      expect(result).toEqual({
        error:
          "This command was not run because it exceeds 64 KB. Put code in a file and run that file.",
      });
      expect(tool).not.toHaveBeenCalled();
      expect(f.sandbox.execute).not.toHaveBeenCalled();
      expect(f.blocks()[0]?.command).toBe("[Invalid command]");
    },
  );
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
  it("skips a card whose commandId already has a command.finished, even when it never reached agent.tool.completed", () => {
    const open = new Map<string, CommandBlock>();
    adoptOpenCommands(
      open,
      [{ type: "command.intent", payload: { block: earlier({ outcome: "waiting" }) } }],
      // The completion never reached agent.tool.completed: the worker died, or the audit
      // append failed, right after this attempt wrote its own command.finished.
      new Set(),
      // Loaded on its own, without any finished command's stdout/stderr payload.
      new Set(["card-earlier"]),
    );
    expect([...open.keys()]).toEqual([]);
  });
  it("never adopts a card a resumed call took over, even after a late event from its attempt", () => {
    const open = new Map<string, CommandBlock>();
    adoptOpenCommands(
      open,
      [
        { type: "command.intent", payload: { block: earlier({ outcome: "waiting" }) } },
        {
          type: "agent.tool.resumed",
          payload: {
            from: "execution-1",
            to: "execution-2",
            fromCommandId: "card-earlier",
            toCommandId: "card-resumed",
          },
        },
        {
          type: "command.intent",
          payload: {
            block: earlier({
              commandId: "card-resumed",
              executionId: "execution-2",
              outcome: "waiting",
            }),
          },
        },
        // The attempt that lost its lease records one more event for the card it no longer has.
        { type: "command.started", payload: { block: earlier({}) } },
      ],
      new Set(),
    );
    expect([...open]).toEqual([
      ["execution-2", expect.objectContaining({ commandId: "card-resumed" })],
    ]);
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
