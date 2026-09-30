import type { ChiefActivity } from "@ardurbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chiefActivityFeed } from "./chief-activity.js";

afterEach(() => vi.useRealTimers());
describe("chief tool feed", () => {
  function feed() {
    const writes: ChiefActivity[] = [];
    const instance = chiefActivityFeed({
      revision: 1,
      runId: "run",
      delegationId: "assignment",
      attempt: 2,
      write: async (activity) => {
        writes.push(activity);
      },
    });
    return { instance, writes };
  }
  it("deduplicates tool identities and retains the last genuine action between tools", async () => {
    const { instance, writes } = feed();
    await instance.start("call", "read-input");
    await instance.start("call", "write-notion");
    await instance.finish("call");
    expect(writes.map((row) => [row.key, row.state])).toEqual([
      ["read-input", "active"],
      ["read-input", "idle"],
    ]);
    expect(writes.every((row) => row.runId === "run" && row.attempt === 2)).toBe(true);
    await instance.settle("completed");
    await instance.start("late", "write-notion");
    expect(writes.at(-1)?.state).toBe("completed");
  });
  it("waits after fifteen seconds only while a tool is still active", async () => {
    vi.useFakeTimers();
    const { instance, writes } = feed();
    await instance.start("slow", "connect-notion");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes.at(-1)?.key).toBe("waiting-tool");
    await instance.finish("slow");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(writes.at(-1)?.state).toBe("idle");
    await instance.settle("completed");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("parallel calls retain another active tool when the latest finishes", async () => {
    const { instance, writes } = feed();
    await instance.start("first", "read-input");
    await instance.start("second", "verify-notion");
    await instance.finish("second");
    expect(writes.at(-1)).toMatchObject({
      key: "read-input",
      state: "active",
      executionId: "first",
    });
    await instance.settle("waiting");
  });
  it("settlement cancels owned timers and overrides tools without waking a model", async () => {
    vi.useFakeTimers();
    const { instance, writes } = feed();
    await instance.start("call", "working");
    await instance.settle("stopped");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes.map((row) => row.state)).toEqual(["active", "stopped"]);
    expect(writes.map((row) => row.sourceSeq)).toEqual([1, 2]);
  });
});
