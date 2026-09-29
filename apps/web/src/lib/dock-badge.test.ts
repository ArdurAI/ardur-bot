// @vitest-environment jsdom
import type { ArdurBotDesktop } from "@ardurbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countOwnerWaiting, openDockSnapshot, publishDockWaitingCount } from "./dock-badge";

afterEach(() => {
  delete window.ardurbotDesktop;
});

describe("dock waiting count", () => {
  it("sends a number only when it changes, including zero", async () => {
    vi.resetModules();
    const { publishDockWaitingCount: publish } = await import("./dock-badge");
    const send = vi.fn<(count: number) => Promise<void>>(async () => undefined);
    for (const count of [1, 1]) publish(count);
    expect(send).not.toHaveBeenCalled();
    window.ardurbotDesktop = {
      dock: { setWaitingCount: send },
    } as unknown as ArdurBotDesktop;
    for (const count of [1, 1, 2, 2, 0, 0, 0]) publish(count);
    expect(send.mock.calls.map(([count]) => count)).toEqual([1, 2, 0]);
  });

  it("does not send the same count again when the desktop call fails", async () => {
    const send = vi.fn(() => Promise.reject(new Error("not ready")));
    window.ardurbotDesktop = {
      dock: { setWaitingCount: send },
    } as unknown as ArdurBotDesktop;
    publishDockWaitingCount(2);
    await Promise.resolve();
    publishDockWaitingCount(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends a new count through the desktop bridge only when it changes", () => {
    const send = vi.fn<(count: number) => Promise<void>>(async () => undefined);
    publishDockWaitingCount(4);
    expect(send).not.toHaveBeenCalled();
    window.ardurbotDesktop = {
      dock: { setWaitingCount: send },
    } as unknown as ArdurBotDesktop;
    publishDockWaitingCount(4);
    publishDockWaitingCount(4);
    publishDockWaitingCount(0);
    publishDockWaitingCount(0);
    expect(send.mock.calls.map(([count]) => count)).toEqual([4, 0]);
  });

  it("uses a snapshot only while its thread is open", () => {
    const snapshot = {
      threadId: "ta",
      runs: [{ botId: "a", status: "waiting_input" }],
    };
    expect(openDockSnapshot(false, snapshot)).toEqual({ snapshot: null, viewingThreadId: null });
    expect(openDockSnapshot(true, null)).toEqual({ snapshot: null, viewingThreadId: null });
    expect(openDockSnapshot(true, snapshot)).toEqual({ snapshot, viewingThreadId: "ta" });
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", status: "idle" }],
        ...openDockSnapshot(false, snapshot),
      }),
    ).toBe(0);
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", status: "waiting_input" }],
        ...openDockSnapshot(false, { threadId: "ta", runs: [] }),
      }),
    ).toBe(1);
  });

  it("counts each waiting bot once", () => {
    expect(
      countOwnerWaiting({
        bots: [
          { id: "a", threadId: "ta", status: "waiting_input" },
          { id: "b", threadId: "tb", status: "waiting_takeover" },
          { id: "c", threadId: "tc", status: "running" },
        ],
      }),
    ).toBe(2);
    expect(
      countOwnerWaiting({
        bots: [
          { id: "a", threadId: "same", status: "waiting_input" },
          { id: "b", threadId: "same", status: "waiting_takeover" },
        ],
      }),
    ).toBe(2);
    expect(
      countOwnerWaiting({
        bots: [],
        snapshot: {
          threadId: "tg",
          runs: [
            { botId: "a", status: "waiting_input" },
            { botId: "b", status: "waiting_takeover" },
          ],
        },
      }),
    ).toBe(2);
    expect(
      countOwnerWaiting({
        bots: [
          { id: "a", threadId: "ta", status: "waiting_input" },
          { id: "b", threadId: "tb", status: "waiting_takeover" },
        ],
        groups: [
          {
            id: "g",
            threadId: "tg",
            members: [
              { botId: "a", status: "waiting_input" },
              { botId: "b", status: "waiting_takeover" },
            ],
          },
        ],
      }),
    ).toBe(2);
    expect(
      countOwnerWaiting({
        bots: [
          { id: "a", threadId: "ta", status: "idle" },
          { id: "b", threadId: "tb", status: "running" },
        ],
        groups: [
          {
            id: "g",
            threadId: "tg",
            members: [
              { botId: "a", status: "waiting_input" },
              { botId: "b", status: "waiting_takeover" },
            ],
          },
        ],
      }),
    ).toBe(2);
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", threadId: "ta", status: "idle" }],
        groups: [
          {
            id: "g1",
            threadId: "t1",
            members: [{ botId: "a", status: "waiting_input" }],
          },
          {
            id: "g2",
            threadId: "t2",
            members: [{ botId: "a", status: "waiting_input" }],
          },
        ],
      }),
    ).toBe(1);
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", threadId: "ta", status: "waiting_input" }],
        snapshot: { threadId: "ta", runs: [{ botId: "a", status: "running" }] },
        viewingThreadId: "ta",
      }),
    ).toBe(1);
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", threadId: "ta", status: "waiting_input" }],
        groups: [
          {
            id: "g",
            threadId: "tg",
            members: [{ botId: "a", status: "waiting_input" }],
          },
        ],
        snapshot: { threadId: "ta", runs: [{ botId: "a", status: "running" }] },
        viewingThreadId: "ta",
      }),
    ).toBe(1);
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", threadId: "ta", status: "waiting_input" }],
        snapshot: { threadId: "ta", runs: [] },
        viewingThreadId: null,
      }),
    ).toBe(1);
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", threadId: "ta", status: "idle" }],
        snapshot: { threadId: "ta", runs: [{ botId: "a", status: "waiting_input" }] },
        viewingThreadId: null,
      }),
    ).toBe(0);
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", threadId: "ta", status: "idle" }],
        snapshot: { threadId: "ta", runs: [{ botId: "a", status: "waiting_input" }] },
        viewingThreadId: "ta",
      }),
    ).toBe(1);
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", threadId: "ta", status: "waiting_input" }],
        snapshot: { threadId: "other", runs: [{ botId: "b", status: "running" }] },
      }),
    ).toBe(1);
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", threadId: "ta", status: "waiting_input" }],
        snapshot: { threadId: "tg", runs: [{ botId: "a", status: "waiting_input" }] },
      }),
    ).toBe(1);
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", threadId: "ta", status: "running" }],
        snapshot: { threadId: "tg", runs: [{ botId: "a", status: "waiting_takeover" }] },
      }),
    ).toBe(1);
    expect(
      countOwnerWaiting({
        bots: [],
        currentSpaceId: null,
        spaces: [
          {
            id: "there",
            bots: [{ id: "c", status: "waiting_input" }],
            groups: [],
          },
        ],
      }),
    ).toBe(0);
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", threadId: "ta", status: "waiting_input" }],
        currentSpaceId: "here",
        spaces: [
          { id: "here", bots: [{ id: "a", status: "waiting_input" }], groups: [] },
          {
            id: "there",
            bots: [
              { id: "c", status: "waiting_input" },
              { id: "d", status: "idle" },
            ],
            groups: [
              {
                id: "g",
                members: [
                  { botId: "c", status: "waiting_input" },
                  { botId: "e", status: "waiting_takeover" },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(3);
  });
});
