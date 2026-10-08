import type { WorkspaceContext } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceReadCancelled, WorkspaceReads } from "./workspace-reads.js";

const context: WorkspaceContext = {
  botId: "bot",
  computerId: "computer",
  rootId: "root",
  generation: 1,
  files: "live",
  observedAt: "2026-09-28T00:00:00.000Z",
};
const conflict = new Error("typed conflict fixture");
function setup() {
  const options = {
    describe: vi.fn().mockResolvedValue({ ...context, generation: 2 }),
    computerChanged: (error: unknown) => error === conflict,
    publish: vi.fn(),
  };
  return { reads: new WorkspaceReads(context, options), ...options };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
describe("workspace read binding", () => {
  it("changes its binding revision only for an external binding, not effect replay or recovery", async () => {
    const { reads } = setup();
    const revision = reads.bind(context);
    reads.dispose();
    reads.activate();
    expect(reads.bind(context)).toBe(revision);
    await reads.read(vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue("current"));
    expect(reads.bind({ ...context, generation: 2 })).toBe(revision);
    expect(reads.bind({ ...context, generation: 5 })).toBe(revision + 1);
  });

  it("reuses a completed refresh for a slower concurrent conflict", async () => {
    const { reads, describe, publish } = setup();
    const slow = deferred<string>();
    const slowRequest = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue("slow read");
    const pending = reads.read(slowRequest);
    const fastRequest = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue("fast read");
    expect(await reads.read(fastRequest)).toBe("fast read");
    slow.reject(conflict);
    expect(await pending).toBe("slow read");
    expect(describe).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(slowRequest).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 2 }));
  });
  it.each(["data", "error"])("discards old %s after another read recovers", async (outcome) => {
    const { reads } = setup();
    const slow = deferred<string>();
    const pending = reads.read(() => slow.promise);
    const cancelled = expect(pending).rejects.toBeInstanceOf(WorkspaceReadCancelled);
    await reads.read(vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue("current"));
    if (outcome === "data") slow.resolve("obsolete");
    else slow.reject(new Error("obsolete error"));
    await cancelled;
  });
  it.each(["binding", "dispose"])("discards a late refresh after %s", async (action) => {
    const { reads, describe, publish } = setup();
    const refresh = deferred<WorkspaceContext>();
    describe.mockReturnValueOnce(refresh.promise);
    const request = vi.fn().mockRejectedValueOnce(conflict);
    const pending = reads.read(request);
    const cancelled = expect(pending).rejects.toBeInstanceOf(WorkspaceReadCancelled);
    await Promise.resolve();
    if (action === "dispose") reads.dispose();
    else reads.bind({ ...context, generation: 5 });
    refresh.resolve({ ...context, generation: 2 });
    await cancelled;
    expect(publish).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("never publishes a describe for another bot", async () => {
    const { reads, describe, publish } = setup();
    describe.mockResolvedValueOnce({ ...context, botId: "other" });
    await expect(reads.read(vi.fn().mockRejectedValueOnce(conflict))).rejects.toBeInstanceOf(
      WorkspaceReadCancelled,
    );
    expect(publish).not.toHaveBeenCalled();
  });
  it("allows a new failure to refresh again after describe failed", async () => {
    const { reads, describe } = setup();
    describe.mockRejectedValueOnce(new Error("offline"));
    await expect(reads.read(vi.fn().mockRejectedValueOnce(conflict))).rejects.toThrow("offline");
    expect(
      await reads.read(vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue("recovered")),
    ).toBe("recovered");
    expect(describe).toHaveBeenCalledTimes(2);
  });
});
