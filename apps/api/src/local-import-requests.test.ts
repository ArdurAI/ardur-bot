import type { BackgroundJob, JobPublisher } from "@ardurbot/adapter-kit";
import { afterEach, expect, it, vi } from "vitest";
import { LocalImportRequests } from "./local-import-requests.js";

afterEach(() => vi.useRealTimers());
const owner = { spaceId: "fixture-space", userId: "fixture-owner" };
it("queues identifiers only, resolves one result and ignores late callbacks", async () => {
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const requests = new LocalImportRequests({ enqueue } as unknown as JobPublisher);
  const result = requests.run(owner, { action: "scan" });
  const job = enqueue.mock.calls[0]![0];
  expect(job.name).toBe("local-import.run");
  if (job.name !== "local-import.run") throw new Error("Wrong job");
  expect(job.payload).toEqual({
    requestId: expect.any(String),
    ...owner,
    action: { action: "scan" },
  });
  requests.complete(job.payload.requestId, {});
  await expect(result).resolves.toEqual({});
  requests.complete(job.payload.requestId, { stopped: "failed" });
});
it("passes a stopped run and its failed items through as a typed answer", async () => {
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const requests = new LocalImportRequests({ enqueue } as unknown as JobPublisher);
  const answers = [
    { stopped: "host" },
    {
      result: {
        created: 2,
        updated: 0,
        unchanged: 0,
        removed: 0,
        skipped: 0,
        conflicts: 0,
        failed: 1,
      },
      failures: [
        {
          itemId: "00000000-0000-4000-8000-000000000003",
          tool: "claude-code",
          category: "skills",
          relativePath: ".claude/skills/review/SKILL.md",
          reason: "credential",
        },
      ],
    },
  ] as const;
  for (const answer of answers) {
    const result = requests.run(owner, { action: "scan" });
    const job = enqueue.mock.calls.at(-1)![0];
    if (job.name !== "local-import.run") throw new Error("Wrong job");
    requests.complete(job.payload.requestId, answer);
    await expect(result).resolves.toEqual(answer);
  }
});
it("times out and surfaces a generic failure without returning worker diagnostics", async () => {
  vi.useFakeTimers();
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const requests = new LocalImportRequests({ enqueue } as unknown as JobPublisher);
  const result = requests.run(owner, { action: "scan" });
  const assertion = expect(result).rejects.toThrow("Re-scan");
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  await assertion;
  const failed = requests.run(owner, { action: "scan" });
  const job = enqueue.mock.calls.at(-1)![0];
  if (job.name !== "local-import.run") throw new Error("Wrong job");
  requests.complete(job.payload.requestId, { private: "fixture-diagnostic" });
  await expect(failed).rejects.toThrow("Import could not finish.");
  await failed.catch((error: Error) => expect(error.message).not.toContain("fixture-diagnostic"));
});
