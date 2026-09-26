import type { ComputerUpdate } from "@ardurbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computerRefusalMessage,
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
describe("computerRefusalMessage", () => {
  const fallback = "Could not change the computer; stop its bots and try again.";
  it("shows the server's sentence for a missing-engine or host-move refusal", () => {
    expect(
      computerRefusalMessage(
        Object.assign(new Error("Reset it in Settings, Computers…"), {
          data: { code: "engine-missing" },
        }),
        fallback,
      ),
    ).toBe("Reset it in Settings, Computers…");
    expect(
      computerRefusalMessage(
        Object.assign(new Error("Choose a saved connection or keep the current engine."), {
          data: { code: "host-move-unavailable" },
        }),
        fallback,
      ),
    ).toBe("Choose a saved connection or keep the current engine.");
  });
  it("keeps the caller's fallback for any other failure, or a non-Error, or no error at all", () => {
    expect(
      computerRefusalMessage(
        Object.assign(new Error("Computer is busy"), { data: { code: "conflict" } }),
        fallback,
      ),
    ).toBe(fallback);
    expect(computerRefusalMessage(new Error("boom"), fallback)).toBe(fallback);
    expect(
      computerRefusalMessage(
        { message: "not an Error", data: { code: "engine-missing" } },
        fallback,
      ),
    ).toBe(fallback);
    expect(computerRefusalMessage(undefined, fallback)).toBe(fallback);
  });
});
