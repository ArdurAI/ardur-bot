import { expect, it, vi } from "vitest";
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
  return { deps, home, request, receipt };
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
  expect(JSON.parse(vi.mocked(f.deps.out).mock.calls[0]![0])).toEqual(f.receipt);
});
it.each(["", " ", "x".repeat(32_001)])(
  "refuses empty/oversized tasks before dispatch",
  async (text) => {
    const f = fixture();
    expect(await runCli(["send", text], f.deps)).toBe(3);
    expect(f.request).not.toHaveBeenCalled();
  },
);
it("refuses duplicate bot names and requires an exact id", async () => {
  const f = fixture();
  f.request.mockResolvedValue([
    { id: "one", name: "Builder" },
    { id: "two", name: "Builder" },
  ]);
  expect(await runCli(["send", "Builder", "Review"], f.deps)).toBe(3);
  expect(f.request).toHaveBeenCalledOnce();
});
it("returns exit 2 and the existing sentence for a revoked grant", async () => {
  const f = fixture();
  f.request.mockRejectedValue(
    new CliError("This device is unavailable; pair it again at home.", 2),
  );
  expect(await runCli(["send", "Review"], f.deps)).toBe(2);
  expect(f.deps.error).toHaveBeenCalledWith("This device is unavailable; pair it again at home.\n");
});
it("waits for the scripted summary, then reads only its final message", async () => {
  const f = fixture();
  let polls = 0;
  f.request.mockImplementation(async (operation: string) => {
    if (operation === "dispatch") return f.receipt;
    if (operation === "tasks") return [f.receipt];
    if (operation === "summaries")
      return ++polls === 1 ? [] : [{ taskId: "task", state: "done", messageId: "answer" }];
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
    "rpc",
    expect.objectContaining({
      procedure: "threads/messages",
      input: expect.objectContaining({ around: { messageId: "answer" } }),
    }),
  );
});
it.each(["failed", "stopped"])("reports terminal %s as exit 1", async (state) => {
  const f = fixture();
  f.request.mockImplementation(async (operation: string) =>
    operation === "dispatch" ? f.receipt : [{ taskId: "task", state }],
  );
  expect(await runCli(["send", "Review", "--wait", "--json"], f.deps)).toBe(1);
});
it("does not accept an answer from a different run", async () => {
  const f = fixture();
  f.request.mockImplementation(async (operation: string) =>
    operation === "dispatch"
      ? f.receipt
      : operation === "summaries"
        ? [{ taskId: "task", state: "done", messageId: "answer" }]
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
  expect(await runCli(["send", "Review", "--wait"], f.deps)).toBe(1);
  expect(f.deps.out).not.toHaveBeenCalled();
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
  expect(await runCli(["send", "Review"], f.deps)).toBe(1);
  expect(f.deps.error).toHaveBeenCalledWith("This request could not finish; try again.\n");
});
it("pair output contains only home name, not the key or pairing challenge", async () => {
  const f = fixture();
  expect(await runCli(["pair", "code", "--json"], f.deps)).toBe(0);
  expect(f.deps.out).toHaveBeenCalledWith('{"homeName":"Home","paired":true}\n');
});
