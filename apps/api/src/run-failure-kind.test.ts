import type { Prisma } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { storedRunFailureKind } from "./run-failure-kind.js";

it("loads the stored kind only for the matching failed run", async () => {
  const findFirst = vi
    .fn()
    .mockResolvedValue({ payload: { error: "Denied", providerErrorKind: "auth" } });
  const tx = { event: { findFirst } } as unknown as Prisma.TransactionClient;
  const run = { id: "run-1", threadId: "thread-1", status: "failed" };
  expect(await storedRunFailureKind(tx, run)).toBe("auth");
  expect(findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { runId: run.id, threadId: run.threadId, type: "run.failed" },
    }),
  );
  expect(await storedRunFailureKind(tx, { ...run, status: "running" })).toBeUndefined();
  expect(findFirst).toHaveBeenCalledOnce();
  findFirst.mockResolvedValue({ payload: { error: "Legacy" } });
  expect(await storedRunFailureKind(tx, run)).toBeUndefined();
  findFirst.mockResolvedValue({ payload: { providerErrorKind: "future-kind" } });
  expect(await storedRunFailureKind(tx, run)).toBeUndefined();
});
