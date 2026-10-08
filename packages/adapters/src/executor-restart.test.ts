import { describe, expect, it, vi } from "vitest";
import { saveTurnProgress, suspendTurn, TurnProgress } from "./turn-progress.js";

describe("durable restart progress", () => {
  it("retains context, pins and completed effects across a new session", () => {
    const progress = new TurnProgress({
      runtimeKind: "pi",
      pin: { modelId: "pinned" },
      history: [],
      prompt: "work",
    });
    progress.runtimeState = [{ role: "assistant", content: "saved model response" }];
    progress.beginEffect("effect-1", "shell", "digest");
    progress.finishEffect("effect-1", { stdout: "completed" });
    const recovered = new TurnProgress(JSON.parse(JSON.stringify(progress.snapshot())));
    expect(recovered.replay("shell", "digest")).toEqual({
      kind: "completed",
      result: { stdout: "completed" },
    });
    expect(recovered.snapshot()).toMatchObject({
      version: 1,
      pin: { modelId: "pinned" },
      runtimeState: [{ content: "saved model response" }],
    });
  });
  it("refuses to repeat an effect with an uncertain outcome", () => {
    const progress = new TurnProgress({ runtimeKind: "pi", pin: {}, history: [], prompt: "work" });
    progress.beginEffect("effect-1", "shell", "digest");
    const recovered = new TurnProgress(progress.snapshot());
    expect(recovered.replay("shell", "digest")).toEqual({ kind: "uncertain" });
  });
  it("fences progress writes and saves before releasing ownership", async () => {
    const calls: unknown[] = [];
    const updateMany = vi.fn(async (input) => {
      calls.push(input);
      return { count: 1 };
    });
    const prisma = { run: { updateMany } };
    await saveTurnProgress(prisma, "run", "worker", 3, "encrypted");
    await suspendTurn(prisma, "run", "worker", 3);
    expect(calls).toEqual([
      {
        where: { id: "run", status: "running", leaseOwner: "worker", leaseFence: 3 },
        data: { turnCheckpoint: "encrypted" },
      },
      {
        where: {
          id: "run",
          status: "running",
          cancelRequestedAt: null,
          leaseOwner: "worker",
          leaseFence: 3,
          turnCheckpoint: { not: null },
        },
        data: { leaseOwner: null, leaseExpiresAt: new Date(0) },
      },
    ]);
  });
  it("does not release a stale writer or a cancelled run", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    await expect(
      saveTurnProgress({ run: { updateMany } }, "run", "worker", 2, "saved"),
    ).rejects.toThrow("ownership");
    expect(await suspendTurn({ run: { updateMany } }, "run", "worker", 2)).toBe(false);
  });
});
