// @vitest-environment jsdom
import type { ArdurBotDesktop } from "@ardurbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countOwnerWaiting,
  createDockWaitingPublisher,
  nextDockWaitingCount,
  publishDockWaitingCount,
} from "./dock-badge";

afterEach(() => {
  delete window.ardurbotDesktop;
});

describe("dock waiting count", () => {
  it("sends a number only when it changes, including zero", () => {
    expect(nextDockWaitingCount(null, 0)).toBe(0);
    expect(nextDockWaitingCount(0, 0)).toBeNull();
    const send = vi.fn();
    const publish = createDockWaitingPublisher(send);
    for (const count of [1, 1, 2, 2, 0, 0, 0]) publish(count);
    expect(send.mock.calls.map(([count]) => count)).toEqual([1, 2, 0]);
  });

  it("retries a count the desktop bridge did not accept", async () => {
    let rejectSend: (error: Error) => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    const publish = createDockWaitingPublisher(send);
    publish(2);
    rejectSend(new Error("not ready"));
    await Promise.resolve();
    publish(2);
    expect(send).toHaveBeenCalledTimes(2);
    const refused = vi.fn(() => false as const);
    const retry = createDockWaitingPublisher(refused);
    retry(3);
    retry(3);
    expect(refused).toHaveBeenCalledTimes(2);
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

  it("counts each waiting thread once", () => {
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
    ).toBe(1);
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
    ).toBe(1);
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
    ).toBe(1);
    expect(
      countOwnerWaiting({
        bots: [{ id: "a", threadId: "ta", status: "waiting_input" }],
        snapshot: { threadId: "ta", runs: [{ botId: "a", status: "running" }] },
      }),
    ).toBe(0);
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
