import { describe, expect, it, vi } from "vitest";
import { updateTaskCard } from "./task-cards.js";

describe("updateTaskCard", () => {
  it("retries a transaction conflict before acknowledging worker progress", async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce({ code: "P2034" })
      .mockResolvedValue({ ok: true });
    const notify = vi.fn();
    await expect(
      updateTaskCard(
        { prisma: { $transaction: transaction }, events: { notify } } as never,
        { runId: "run", executionId: "progress-1", tool: "report_progress", args: {} } as never,
      ),
    ).resolves.toEqual({ ok: true });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
  });
});
