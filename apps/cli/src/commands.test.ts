import { afterEach, expect, it, vi } from "vitest";
import type { CommandDependencies, DeviceClient } from "./commands.js";
import { runCli } from "./commands.js";
import { createDeviceKeys } from "./crypto.js";
import { CliError } from "./transport.js";

function fixture() {
  const home = {
    version: 1 as const,
    instanceId: "home",
    homeName: "Home",
    challenge: "c".repeat(32),
    fingerprint: "a".repeat(64),
    certificateFingerprint: "b".repeat(64),
    hints: ["https://home.example.test"],
    url: "https://home.example.test",
    grantId: "grant",
    spaceId: "space",
    privateKey: createDeviceKeys().privateKey,
  };
  const receipt = {
    taskId: "task",
    runId: "run",
    botId: "bot",
    threadId: "thread",
    state: "accepted",
    cancelRequested: false,
  };
  const request = vi.fn(async (operation: string, body?: unknown): Promise<unknown> => {
    if (operation === "dispatch") return receipt;
    if (operation === "stop") return { cancelRequested: true };
    if (operation === "tasks") return [receipt];
    if (operation === "summaries") return [];
    if (operation === "rpc" && (body as { procedure: string }).procedure === "bots/list")
      return [{ id: "bot", name: "Builder" }];
    return { ok: true };
  });
  const deps: CommandDependencies = {
    now: () => 0,
    transcript: vi.fn(),
    load: vi.fn(async () => home),
    save: vi.fn(async () => undefined),
    pair: vi.fn(async () => home),
    client: () => ({ request }) as DeviceClient,
    file: vi.fn(async () => "Review the change"),
    sleep: vi.fn(async () => undefined),
    out: vi.fn(),
    error: vi.fn(),
  };
  const run = {
    ...receipt,
    status: "completed",
    state: "done",
    cancelConfirmed: false,
    messageId: "answer",
    failure: null,
    createdAt: "2026-10-08T00:00:00Z",
    startedAt: null,
    completedAt: null,
  };
  return { deps, home, request, receipt, run };
}
it("dispatches a named bot through existing read RPC, prints receipt ids and keeps keys private", async () => {
  const f = fixture();
  expect(await runCli(["send", "Builder", "Review"], f.deps)).toBe(0);
  expect(f.request).toHaveBeenCalledWith(
    "dispatch",
    expect.objectContaining({ botId: "bot", text: "Review" }),
  );
  expect(f.deps.out).toHaveBeenCalledWith("Task task\nRun run\n");
  expect(
    JSON.stringify([vi.mocked(f.deps.out).mock.calls, vi.mocked(f.deps.error).mock.calls]),
  ).not.toContain(f.home.privateKey);
});
it("supports file input and JSON without echoing the task or config", async () => {
  const f = fixture();
  expect(await runCli(["send", "--file", "brief.md", "--json"], f.deps)).toBe(0);
  expect(f.deps.file).toHaveBeenCalledWith("brief.md");
  expect(JSON.parse(vi.mocked(f.deps.out).mock.calls[0]![0])).toMatchObject({
    version: 1,
    verdict: "pass",
    data: f.receipt,
  });
});
it.each(["", " ", "x".repeat(32_001)])(
  "refuses empty/oversized tasks before dispatch",
  async (text) => {
    const f = fixture();
    expect(await runCli(["send", text], f.deps)).toBe(4);
    expect(f.request).not.toHaveBeenCalled();
  },
);
it("refuses duplicate bot names and requires an exact id", async () => {
  const f = fixture();
  f.request.mockResolvedValue([
    { id: "one", name: "Builder" },
    { id: "two", name: "Builder" },
  ]);
  expect(await runCli(["send", "Builder", "Review"], f.deps)).toBe(4);
  expect(f.request).toHaveBeenCalledOnce();
});
it("returns exit 4 and the existing sentence for a revoked grant", async () => {
  const f = fixture();
  f.request.mockRejectedValue(
    new CliError("This device is unavailable; pair it again at home.", 2),
  );
  expect(await runCli(["send", "Review"], f.deps)).toBe(4);
  expect(f.deps.out).toHaveBeenCalledWith("This device is unavailable; pair it again at home.\n");
});
it("waits for the exact run, then reads only its final message", async () => {
  const f = fixture();
  let polls = 0;
  f.request.mockImplementation(async (operation: string) => {
    if (operation === "dispatch") return f.receipt;
    if (operation === "tasks") return [f.receipt];
    if (operation === "runs/get")
      return { run: ++polls === 1 ? { ...f.run, status: "running", state: "running" } : f.run };
    return {
      threadId: "thread",
      messages: [
        {
          id: "other",
          runId: "other-run",
          role: "bot",
          blocks: [{ kind: "text", text: "Not this answer" }],
        },
        {
          id: "answer",
          runId: "run",
          role: "bot",
          blocks: [
            { kind: "progress", text: "Reasoning", reasoning: true },
            { kind: "text", text: "Hidden reasoning", reasoning: true },
            { kind: "text", text: "The final answer" },
          ],
        },
      ],
    };
  });
  expect(await runCli(["send", "Review", "--wait"], f.deps)).toBe(0);
  expect(f.deps.sleep).toHaveBeenCalledOnce();
  expect(f.deps.out).toHaveBeenCalledWith("The final answer\n");
  expect(f.request).toHaveBeenCalledWith(
    "messages/get",
    expect.objectContaining({ around: { messageId: "answer" } }),
  );
});
it.each(["failed", "stopped"])("reports terminal %s as exit 2", async (state) => {
  const f = fixture();
  f.request.mockImplementation(async (operation: string) =>
    operation === "dispatch"
      ? f.receipt
      : {
          run: {
            ...f.run,
            status: state === "failed" ? "failed" : "cancelled",
            state,
            cancelConfirmed: state === "stopped",
            failure: { category: "other", message: "The bot run failed." },
          },
        },
  );
  expect(await runCli(["send", "Review", "--wait", "--json"], f.deps)).toBe(2);
});
it("does not accept an answer from a different run", async () => {
  const f = fixture();
  f.request.mockImplementation(async (operation: string) =>
    operation === "dispatch"
      ? f.receipt
      : operation === "runs/get"
        ? { run: f.run }
        : {
            threadId: "thread",
            messages: [
              {
                id: "answer",
                runId: "other",
                role: "bot",
                blocks: [{ kind: "text", text: "Wrong answer" }],
              },
            ],
          },
  );
  expect(await runCli(["send", "Review", "--wait"], f.deps)).toBe(2);
  expect(f.deps.out).toHaveBeenCalledWith(expect.stringContaining("answer is unavailable"));
});
it("handles stop and checks live validity on status", async () => {
  const f = fixture();
  expect(await runCli(["stop", "task"], f.deps)).toBe(0);
  expect(f.request).toHaveBeenCalledWith("stop", { taskId: "task" });
  expect(await runCli(["status"], f.deps)).toBe(0);
  expect(f.request).toHaveBeenCalledWith("tasks");
});
it("never echoes unexpected diagnostics containing a private key", async () => {
  const f = fixture();
  f.request.mockRejectedValue(new Error(f.home.privateKey));
  expect(await runCli(["send", "Review"], f.deps)).toBe(2);
  expect(f.deps.out).toHaveBeenCalledWith(
    "This request could not finish; check it at home before trying again.\n",
  );
});
it("pair output contains only home name, not the key or pairing challenge", async () => {
  const f = fixture();
  expect(await runCli(["pair", "code", "--json"], f.deps)).toBe(0);
  expect(f.deps.out).toHaveBeenCalledWith('{"homeName":"Home","paired":true}\n');
});

afterEach(() => vi.useRealTimers());
it("recovers a lost admission response using an explicit stable request id", async () => {
  const f = fixture();
  const id = "stable-request-id-0001";
  const input = ["send", "Review", "--request-id", id, "--json"];
  const original = f.request.getMockImplementation()!;
  let lost = true;
  f.request.mockImplementation((operation, body) => {
    if (operation === "dispatch" && lost) {
      lost = false;
      return Promise.reject(new CliError("Home could not be reached."));
    }
    return original(operation, body);
  });
  expect(await runCli(input, f.deps)).toBe(2);
  expect(await runCli(input, f.deps)).toBe(0);
  const sends = f.request.mock.calls.filter(([op]) => op === "dispatch");
  expect(sends).toHaveLength(2);
  expect(sends[0]![1]).toEqual(sends[1]![1]);
  expect(sends[0]![1]).toMatchObject({ clientNonce: id });
  expect(JSON.parse(vi.mocked(f.deps.out).mock.calls[1]![0])).toMatchObject({
    taskId: "task",
    runId: "run",
  });
});
it("resumes without dispatch or the bounded task and summary lists", async () => {
  const f = fixture();
  f.request.mockResolvedValue({
    run: {
      ...f.run,
      status: "failed",
      state: "failed",
      failure: { category: "other", message: "The bot run failed." },
    },
  });
  expect(await runCli(["wait", "--run", "run", "--json"], f.deps)).toBe(2);
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenCalledWith("runs/get", { runId: "run" });
  expect(JSON.parse(vi.mocked(f.deps.out).mock.calls[0]![0])).toMatchObject({
    version: 1,
    taskId: "task",
    runId: "run",
    verdict: "failed",
  });
});
it("reports a completed run with no saved answer instead of passing", async () => {
  const f = fixture();
  f.request.mockResolvedValue({
    run: {
      ...f.run,
      messageId: null,
      failure: {
        category: "other",
        message: "The task finished, but its answer is unavailable. Open it at home.",
      },
    },
  });
  expect(await runCli(["wait", "--run", "run", "--json"], f.deps)).toBe(2);
  expect(JSON.parse(vi.mocked(f.deps.out).mock.calls[0]![0])).toMatchObject({
    verdict: "error",
    failureReason: "The task finished, but its answer is unavailable. Open it at home.",
  });
});
it.each(["waiting_input", "waiting_takeover"])(
  "returns an action sentence for %s",
  async (status) => {
    const f = fixture();
    f.request.mockResolvedValue({ run: { ...f.run, status, state: "running" } });
    expect(await runCli(["wait", "--run", "run", "--json"], f.deps)).toBe(4);
    expect(f.request).toHaveBeenCalledOnce();
    expect(vi.mocked(f.deps.out).mock.calls[0]![0]).toContain("needs input at home");
  },
);
it("stop reports cancellation requested before confirmation, never stopped", async () => {
  const f = fixture();
  f.run.cancelRequested = true;
  f.run.cancelConfirmed = false;
  f.run.status = "running";
  f.run.state = "running";
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation((operation, body) =>
    operation === "runs/get" ? Promise.resolve({ run: f.run }) : original(operation, body),
  );
  expect(await runCli(["stop", "task"], f.deps)).toBe(0);
  expect(f.deps.out).toHaveBeenLastCalledWith("Cancellation requested for task.\n");
  expect(f.deps.out).not.toHaveBeenCalledWith(expect.stringMatching(/stopped|cancelled/i));
  expect(await runCli(["runs", "show", "run", "--json"], f.deps)).toBe(0);
  expect(JSON.parse(vi.mocked(f.deps.out).mock.calls[1]![0])).toMatchObject({
    verdict: "pass",
    data: { run: { status: "running", cancelRequested: true, cancelConfirmed: false } },
  });
});
it("a requested cancellation keeps waiting; only confirmation stops it", async () => {
  const f = fixture();
  f.request
    .mockResolvedValueOnce({
      run: { ...f.run, status: "running", state: "running", cancelRequested: true },
    })
    .mockResolvedValueOnce({
      run: {
        ...f.run,
        status: "cancelled",
        state: "stopped",
        cancelRequested: true,
        cancelConfirmed: true,
      },
    });
  expect(await runCli(["wait", "--run", "run"], f.deps)).toBe(2);
  expect(f.deps.sleep).toHaveBeenCalledOnce();
});
it("deadline bounds a hung resume read without cancellation or late dispatch", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.request.mockImplementation(() => new Promise(() => undefined));
  const pending = runCli(["wait", "--run", "run", "--timeout", "1s", "--json"], f.deps);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toBe(3);
  expect(f.request).toHaveBeenCalledOnce();
  expect(JSON.parse(vi.mocked(f.deps.out).mock.calls[0]![0])).toMatchObject({
    verdict: "deadline",
    runId: "run",
  });
});
it("reads a failed run successfully and keeps list cursors and exact task ids", async () => {
  const f = fixture();
  const failed = { ...f.run, status: "failed", state: "failed" };
  f.request
    .mockResolvedValueOnce({ run: failed })
    .mockResolvedValueOnce({ task: failed })
    .mockResolvedValueOnce({ runs: [failed], nextCursor: "run" });
  expect(await runCli(["runs", "show", "run", "--json"], f.deps)).toBe(0);
  expect(await runCli(["tasks", "show", "task", "--json"], f.deps)).toBe(0);
  expect(
    await runCli(["runs", "list", "--cursor", "older", "--limit", "2", "--json"], f.deps),
  ).toBe(0);
  expect(f.request.mock.calls).toEqual([
    ["runs/get", { runId: "run" }],
    ["tasks/get", { taskId: "task" }],
    ["runs/list", { cursor: "older", limit: 2 }],
  ]);
  expect(vi.mocked(f.deps.out).mock.calls).toHaveLength(3);
  expect(f.deps.error).not.toHaveBeenCalled();
});

it.each(["failed", "stopped"])(
  "recovered terminal admission %s is not a completion pass",
  async (state) => {
    const f = fixture();
    f.request.mockResolvedValue({ ...f.receipt, state });
    expect(
      await runCli(["send", "Review", "--request-id", "stable-request-0001", "--json"], f.deps),
    ).toBe(2);
    expect(JSON.parse(vi.mocked(f.deps.out).mock.calls[0]![0])).toMatchObject({
      verdict: state,
      taskId: "task",
      runId: "run",
    });
  },
);
it.each(["\ud800", "\udfff"])("refuses unrepresentable send text before signing", async (unit) => {
  const f = fixture();
  expect(await runCli(["send", unit, "--json"], f.deps)).toBe(4);
  expect(f.request).not.toHaveBeenCalled();
  expect(vi.mocked(f.deps.out).mock.calls[0]![0]).toContain("well-formed Unicode");
});
