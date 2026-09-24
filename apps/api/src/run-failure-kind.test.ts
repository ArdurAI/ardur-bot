import type { Prisma } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { storedRunFailure, storedRunFailureKind } from "./run-failure-kind.js";

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

it("restores a typed pin problem after reload", async () => {
  const runtimeProblem = {
    kind: "problem",
    code: "pin-credential-missing",
    pin: {
      // Stored pin problems now include the parsed runtime kind.
      runtimeKind: "pi",
      provider: "xai",
      modelId: "grok-4.6",
      effort: "high",
      credentialId: "deleted",
      revision: 1,
    },
    reason: "Missing connection",
    actions: ["connect", "change-pin"],
  };
  const tx = {
    event: {
      findFirst: vi.fn(async () => ({ payload: { runtimeProblem, error: "untrusted long text" } })),
    },
  } as unknown as Prisma.TransactionClient;
  expect(await storedRunFailure(tx, { id: "run", threadId: "thread", status: "failed" })).toEqual({
    runtimeProblem,
    providerErrorKind: undefined,
  });
});
