import type { ComputerUpdate } from "@ardurbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computerUpdateAttentionMessage,
  computerUpdateOffersRecover,
  createComputerUpdates,
} from "./computer-updates.js";

const update: ComputerUpdate = {
  id: "update-1",
  botId: "bot-1",
  name: "Writer",
  mode: "team",
  action: "update",
  status: "running",
  stage: "saving",
};
afterEach(() => vi.useRealTimers());
describe("computer update presentation", () => {
  it("keeps a newly started update when an older poll returns, and closing does not stop polling", async () => {
    vi.useFakeTimers();
    let resolve!: (rows: ComputerUpdate[]) => void;
    const list = vi.fn(
      () =>
        new Promise<ComputerUpdate[]>((done) => {
          resolve = done;
        }),
    );
    const store = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      releaseInterrupted: async () => {},
    });
    const stop = store.watch();
    await store.start("bot-1");
    resolve([]);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual({ updates: [update], openId: update.id });
    store.open(null);
    await vi.advanceTimersByTimeAsync(1500);
    resolve([{ ...update, stage: "restoring" }]);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual({
      updates: [{ ...update, stage: "restoring" }],
      openId: null,
    });
    stop();
  });
  it("restores background progress on a new mount and ignores responses after disposal", async () => {
    vi.useFakeTimers();
    const store = createComputerUpdates({
      list: async () => [update],
      start: async () => update,
      dismiss: async () => {},
      releaseInterrupted: async () => {},
    });
    let stop = store.watch();
    await Promise.resolve();
    expect(store.getSnapshot().updates).toEqual([update]);
    stop();
    stop = store.watch();
    stop();
    await Promise.resolve();
    expect(store.getSnapshot().updates).toEqual([]);
  });
});
describe("computerUpdateOffersRecover", () => {
  it("offers Recover for an ordinary failure, never for one with a missing-engine reason", () => {
    expect(computerUpdateOffersRecover({ status: "failed" })).toBe(true);
    expect(
      computerUpdateOffersRecover({
        status: "failed",
        failureReason:
          "This computer runs on E2B, which is not configured here. Reset it in Settings, Computers to start it on this deployment's engine, or configure E2B again.",
      }),
    ).toBe(false);
    expect(computerUpdateOffersRecover({ status: "interrupted" })).toBe(false);
    expect(computerUpdateOffersRecover({ status: "running" })).toBe(false);
  });
});
describe("computerUpdateAttentionMessage", () => {
  const copy = { interrupted: "interrupted-copy", generic: "generic-copy" };
  it("shows the missing-engine sentence in place of the generic recovery warning", () => {
    expect(computerUpdateAttentionMessage({ status: "failed" }, copy)).toBe("generic-copy");
    expect(
      computerUpdateAttentionMessage({ status: "failed", failureReason: "engine gone" }, copy),
    ).toBe("engine gone");
    expect(computerUpdateAttentionMessage({ status: "interrupted" }, copy)).toBe(
      "interrupted-copy",
    );
    expect(
      computerUpdateAttentionMessage({ status: "interrupted", failureReason: "engine gone" }, copy),
    ).toBe("interrupted-copy");
  });
});
