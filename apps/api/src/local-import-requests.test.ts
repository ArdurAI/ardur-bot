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
  requests.complete(job.payload.requestId, undefined, true);
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
  requests.complete(job.payload.requestId, { private: "fixture-diagnostic" }, true);
  await expect(failed).rejects.toThrow("Import could not finish.");
});
