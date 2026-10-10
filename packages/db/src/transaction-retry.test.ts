import { describe, expect, it, vi } from "vitest";
import { isRetryableTransactionConflict, withTransactionRetry } from "./transaction-retry.js";

function prismaP2034Error() {
  return Object.assign(
    new Error(
      "Transaction failed due to a write conflict or a deadlock. Please retry your transaction.",
    ),
    { code: "P2034" },
  );
}

function driverAdapterError(originalCode: "40001" | "40P01" | "23505") {
  return Object.assign(new Error("driver adapter error"), {
    code: "P2039",
    meta: { driverAdapterError: { cause: { originalCode } } },
  });
}

describe("isRetryableTransactionConflict", () => {
  it("detects Prisma P2034 write conflicts", () => {
    expect(isRetryableTransactionConflict(prismaP2034Error())).toBe(true);
  });

  it.each(["40001", "40P01"] as const)(
    "detects database conflict code %s in driver adapter errors",
    (code) => {
      expect(isRetryableTransactionConflict(driverAdapterError(code))).toBe(true);
    },
  );

  it("returns false for non-conflict database errors", () => {
    expect(isRetryableTransactionConflict(driverAdapterError("23505"))).toBe(false);
    expect(isRetryableTransactionConflict(new Error("generic error"))).toBe(false);
    expect(isRetryableTransactionConflict(null)).toBe(false);
    expect(isRetryableTransactionConflict(undefined)).toBe(false);
  });
});

describe("withTransactionRetry", () => {
  it("returns operation result immediately on success", async () => {
    const sleep = vi.fn();
    const operation = vi.fn().mockResolvedValue("done");

    const result = await withTransactionRetry(operation, { sleep });

    expect(result).toBe("done");
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient write conflicts with backoff and jitter before succeeding", async () => {
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    const operation = vi
      .fn()
      .mockRejectedValueOnce(prismaP2034Error())
      .mockRejectedValueOnce(driverAdapterError("40001"))
      .mockResolvedValue("recovered");

    const result = await withTransactionRetry(operation, {
      baseDelayMs: 10,
      jitterMs: 5,
      sleep,
    });

    expect(result).toBe("recovered");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // Attempt 1: backoff is 10, jitter in [0, 5] -> delay between 10 and 15
    expect(sleeps[0]).toBeGreaterThanOrEqual(10);
    expect(sleeps[0]).toBeLessThanOrEqual(15);
    // Attempt 2: backoff is 20, jitter in [0, 5] -> delay between 20 and 25
    expect(sleeps[1]).toBeGreaterThanOrEqual(20);
    expect(sleeps[1]).toBeLessThanOrEqual(25);
  });

  it("does not retry non-conflict errors and rethrows immediately", async () => {
    const sleep = vi.fn();
    const error = new Error("syntax error");
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withTransactionRetry(operation, { sleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("tags exhausted retryable conflicts with retryable: true and rethrows", async () => {
    const sleep = vi.fn();
    const conflict = prismaP2034Error();
    const operation = vi.fn().mockRejectedValue(conflict);

    const error = await withTransactionRetry(operation, {
      maxAttempts: 3,
      sleep,
    }).catch((err) => err);

    expect(error).toBe(conflict);
    expect(error.retryable).toBe(true);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
