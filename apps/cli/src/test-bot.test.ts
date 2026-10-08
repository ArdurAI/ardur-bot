import { afterEach, expect, it, vi } from "vitest";
import type { DeviceClient } from "./commands.js";
import { runCli } from "./commands.js";
import { createDeviceKeys } from "./crypto.js";
import { CliError } from "./transport.js";

const args = ["test", "bot", "Builder", "--prompt", "Reply READY", "--expect-contains", "READY"];
function fixture() {
  const receipt = {
    taskId: "task",
    runId: "run",
    botId: "bot",
    threadId: "thread",
    state: "accepted",
    cancelRequested: false,
  };
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
  let state = "done";
  let reply = "READY";
  let runId = "run";
  const request = vi.fn(async (operation: string, body?: unknown): Promise<unknown> => {
    if (operation === "dispatch") return receipt;
    if (operation === "tasks") return [receipt];
    if (operation === "summaries")
      return state === "running" ? [] : [{ taskId: "task", state, messageId: "answer" }];
    if ((body as { procedure?: string })?.procedure === "bots/list")
      return [{ id: "bot", name: "Builder" }];
    return {
      threadId: "thread",
      messages: [
        {
          id: "other",
          runId: "other-run",
          role: "bot",
          blocks: [{ kind: "text", text: "READY wrong" }],
        },
        {
          id: "answer",
          runId,
          role: "bot",
          blocks: [
            { kind: "text", text: "READY reasoning", reasoning: true },
            { kind: "progress", text: "READY progress" },
            { kind: "text", text: reply },
          ],
        },
      ],
    };
  });
  const transcript = { write: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  const deps = {
    load: vi.fn(async () => home),
    save: vi.fn(async () => undefined),
    pair: vi.fn(async () => home),
    client: () => ({ request }) as DeviceClient,
    file: vi.fn(async () => ""),
    sleep: vi.fn(async () => undefined),
    now: () => 100,
    transcript: vi.fn(async () => transcript),
    out: vi.fn(),
    error: vi.fn(),
  };
  return {
    deps,
    request,
    receipt,
    transcript,
    setState: (value: string) => {
      state = value;
    },
    setReply: (value: string) => {
      reply = value;
    },
    setRun: (value: string) => {
      runId = value;
    },
  };
}
afterEach(() => vi.useRealTimers());
it("passes one turn through dispatch and writes exactly one versioned JSON fixture", async () => {
  const f = fixture();
  expect(await runCli([...args, "--json"], f.deps)).toBe(0);
  expect(f.request).toHaveBeenCalledWith(
    "dispatch",
    expect.objectContaining({ botId: "bot", text: "Reply READY" }),
  );
  expect(f.request.mock.calls.filter(([op]) => op === "dispatch")).toHaveLength(1);
  expect(f.deps.out).toHaveBeenCalledOnce();
  expect(JSON.parse(f.deps.out.mock.calls[0]![0])).toEqual({
    version: 1,
    bot: { id: "bot", name: "Builder" },
    runId: "run",
    taskId: "task",
    verdict: "pass",
    replyText: "READY",
    elapsedMs: 0,
    failureReason: null,
  });
  expect(f.deps.error).not.toHaveBeenCalled();
  expect(f.deps.transcript).not.toHaveBeenCalled();
});
it("returns 1 only when the exact reply does not contain the expectation", async () => {
  const f = fixture();
  f.setReply("Not ready");
  expect(await runCli(args, f.deps)).toBe(1);
  expect(f.deps.out).toHaveBeenCalledWith(
    expect.stringContaining("Reply did not contain the expected text."),
  );
});
it.each(["failed", "stopped"])("returns 2 and a safe %s reason", async (state) => {
  const f = fixture();
  f.setState(state);
  f.setReply("Safe failure detail");
  expect(await runCli([...args, "--json"], f.deps)).toBe(2);
  expect(JSON.parse(f.deps.out.mock.calls[0]![0])).toMatchObject({
    verdict: state,
    failureReason: "Safe failure detail",
    runId: "run",
  });
});
it("stops waiting at the deadline with both admitted ids and never cancels work", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.setState("running");
  f.deps.sleep.mockImplementation(() => new Promise(() => undefined));
  const pending = runCli([...args, "--timeout", "1s"], f.deps);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toBe(3);
  expect(f.deps.out).toHaveBeenCalledWith(expect.stringContaining("Task task\nRun run"));
  expect(f.request.mock.calls.some(([op]) => op === "stop")).toBe(false);
});
it("deadline also bounds a hung request, and late completion starts no dispatch", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.request.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = runCli([...args, "--timeout", "1s", "--json"], f.deps);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toBe(3);
  expect(JSON.parse(f.deps.out.mock.calls[0]![0])).toMatchObject({
    verdict: "deadline",
    runId: null,
    taskId: null,
  });
  resolve([{ id: "bot", name: "Builder" }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.request).toHaveBeenCalledOnce();
});
it("returns 4 for revoked pairing and keeps JSON errors on stdout in the same fixture shape", async () => {
  const f = fixture();
  f.request.mockRejectedValue(
    new CliError("This device is unavailable; pair it again at home.", 2),
  );
  expect(await runCli([...args, "--json"], f.deps)).toBe(4);
  expect(JSON.parse(f.deps.out.mock.calls[0]![0])).toMatchObject({
    version: 1,
    verdict: "error",
    failureReason: "This device is unavailable; pair it again at home.",
    runId: null,
  });
  expect(f.deps.out).toHaveBeenCalledOnce();
  expect(f.deps.error).not.toHaveBeenCalled();
});
it("prints candidates for an ambiguous bot without dispatch", async () => {
  const f = fixture();
  f.request.mockResolvedValue([
    { id: "one", name: "Builder" },
    { id: "two", name: "Builder" },
  ]);
  expect(await runCli(args, f.deps)).toBe(4);
  expect(f.deps.out).toHaveBeenCalledWith(expect.stringContaining("one\tBuilder\ntwo\tBuilder"));
  expect(f.request).toHaveBeenCalledOnce();
});
it("prints candidates for an unknown bot", async () => {
  const f = fixture();
  expect(
    await runCli(
      args.map((s) => (s === "Builder" ? "Unknown" : s)),
      f.deps,
    ),
  ).toBe(4);
  expect(f.deps.out).toHaveBeenCalledWith(expect.stringContaining("bot\tBuilder"));
});
it("ignores a wrong-run final reply until the deadline", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.setRun("wrong");
  f.deps.sleep.mockImplementation(() => new Promise(() => undefined));
  const pending = runCli([...args, "--timeout", "1s", "--json"], f.deps);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toBe(3);
  expect(JSON.parse(f.deps.out.mock.calls[0]![0])).toMatchObject({
    verdict: "deadline",
    replyText: "",
    runId: "run",
  });
});
it("refuses an unsafe transcript before any request", async () => {
  const f = fixture();
  f.deps.transcript.mockRejectedValue(new CliError("Choose a safe private transcript file.", 3));
  expect(await runCli([...args, "--transcript", "../outside.json"], f.deps)).toBe(4);
  expect(f.request).not.toHaveBeenCalled();
});
it("records prompt, reply, ids and verdict only when asked; matches before redaction", async () => {
  const f = fixture();
  f.setReply("password=fake-value");
  const secretArgs = [...args];
  secretArgs[6] = "fake-value";
  expect(await runCli([...secretArgs, "--transcript", "check.json"], f.deps)).toBe(0);
  expect(f.transcript.write).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: "Reply READY",
      replyText: "password=fake-value",
      runId: "run",
      taskId: "task",
      verdict: "pass",
    }),
  );
  expect(f.transcript.close).toHaveBeenCalledOnce();
});
it.each([
  ["--timeout", "0s"],
  ["--timeout", "Infinity"],
  ["--timeout", "2d"],
  ["--expect-contains", ""],
  ["--prompt", " "],
])("reports invalid %s as 4 with a single JSON object", async (flag, value) => {
  const f = fixture();
  const index = args.indexOf(flag);
  const input = args.filter((_, i) => index < 0 || (i !== index && i !== index + 1));
  expect(await runCli([...input, flag, value, "--json"], f.deps)).toBe(4);
  expect(JSON.parse(f.deps.out.mock.calls[0]![0])).toMatchObject({ version: 1, verdict: "error" });
  expect(f.request).not.toHaveBeenCalled();
});

it("strips terminal sequences and redacts credential-shaped values from human and JSON results", async () => {
  for (const json of [false, true]) {
    const f = fixture();
    f.setReply("\u001b[31mREADY\u001b[0m password=fake-value");
    expect(await runCli([...args, ...(json ? ["--json"] : [])], f.deps)).toBe(0);
    const printed = f.deps.out.mock.calls[0]![0];
    expect(printed).not.toContain("\u001b");
    expect(printed).not.toContain("fake-value");
    if (json) expect(JSON.parse(printed)).toMatchObject({ replyText: "READY password=[Redacted]" });
  }
});
it("retains admission ids when a later request is revoked", async () => {
  const f = fixture();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation((operation, body) =>
    operation === "summaries"
      ? Promise.reject(new CliError("This device is unavailable; pair it again at home.", 2))
      : original(operation, body),
  );
  expect(await runCli([...args, "--json"], f.deps)).toBe(4);
  expect(JSON.parse(f.deps.out.mock.calls[0]![0])).toMatchObject({
    taskId: "task",
    runId: "run",
    verdict: "error",
  });
});
it("reports an immediate stopped receipt without waiting", async () => {
  const f = fixture();
  f.receipt.state = "stopped";
  expect(await runCli(args, f.deps)).toBe(2);
  expect(f.request.mock.calls.some(([op]) => op === "summaries")).toBe(false);
});
it("hides unexpected remote diagnostics and keeps the admitted ids", async () => {
  const f = fixture();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation((op, body) =>
    op === "summaries" ? Promise.reject(new Error("private remote detail")) : original(op, body),
  );
  expect(await runCli([...args, "--json"], f.deps)).toBe(2);
  const printed = f.deps.out.mock.calls[0]![0];
  expect(printed).not.toContain("private remote detail");
  expect(JSON.parse(printed)).toMatchObject({ taskId: "task", runId: "run" });
});
it.each(["thread", "role", "message", "reasoning", "kind"])(
  "cannot pass using a mismatched %s",
  async (field) => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((op, body) => {
      if ((body as { procedure?: string })?.procedure !== "threads/messages")
        return original(op, body);
      return Promise.resolve({
        threadId: field === "thread" ? "wrong-thread" : "thread",
        messages: [
          {
            id: field === "message" ? "wrong-id" : "answer",
            runId: "run",
            role: field === "role" ? "user" : "bot",
            blocks: [
              {
                kind: field === "kind" ? "progress" : "text",
                text: "READY",
                reasoning: field === "reasoning",
              },
            ],
          },
        ],
      });
    });
    f.deps.sleep.mockImplementation(() => new Promise(() => undefined));
    const pending = runCli([...args, "--timeout", "1s", "--json"], f.deps);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe(field === "reasoning" || field === "kind" ? 1 : 3);
    expect(JSON.parse(f.deps.out.mock.calls[0]![0]).verdict).not.toBe("pass");
  },
);
it("reports transcript write failure without losing ids or printing success", async () => {
  const f = fixture();
  f.transcript.write.mockRejectedValueOnce(
    new CliError("The private transcript could not be saved.", 3),
  );
  expect(await runCli([...args, "--transcript", "check.json", "--json"], f.deps)).toBe(4);
  expect(f.request.mock.calls.some(([op]) => op === "dispatch")).toBe(false);
});

it("redacts credentials even when terminal controls split their field name", async () => {
  const f = fixture();
  f.setReply("READY pass\u001b[0mword=fake-value");
  expect(await runCli([...args, "--json"], f.deps)).toBe(0);
  expect(f.deps.out.mock.calls[0]![0]).not.toContain("fake-value");
});

it.each(["failed", "stopped"])(
  "reports %s even when its failure message belongs to a different run",
  async (state) => {
    const f = fixture();
    f.setState(state);
    f.setRun("wrong");
    f.deps.sleep.mockRejectedValue(new Error("must not keep waiting"));
    expect(await runCli([...args, "--json"], f.deps)).toBe(2);
    expect(JSON.parse(f.deps.out.mock.calls[0]![0])).toMatchObject({
      verdict: state,
      replyText: "",
    });
    expect(f.deps.sleep).not.toHaveBeenCalled();
  },
);
