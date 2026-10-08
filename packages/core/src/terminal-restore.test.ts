import { describe, expect, it } from "vitest";
import { restoreTerminalCollection, terminalCollectionKey } from "./terminal-restore.js";

const scope = {
  userId: "owner",
  spaceId: "space",
  botId: "bot",
  computerId: "computer",
  generation: 2,
};
const snapshot = {
  version: 1,
  savedAt: 1_000,
  sessions: [
    { id: "opaque-one", number: 1, cols: 80, rows: 24 },
    { id: "opaque-two", number: 2, cols: 40, rows: 12 },
  ],
  activeId: "opaque-two",
};
describe("transient terminal restoration", () => {
  it("restores only identities and sizes inside the exact grace window", () => {
    expect(
      restoreTerminalCollection(
        {
          ...snapshot,
          text: "discarded",
          sessions: snapshot.sessions.map((session) => ({ ...session, output: "discarded" })),
        },
        31_000,
      ),
    ).toEqual({ sessions: snapshot.sessions, activeId: snapshot.activeId });
    expect(restoreTerminalCollection(snapshot, 31_001)).toBeNull();
    expect(restoreTerminalCollection(snapshot, 999)).toBeNull();
  });
  it("separates account, space, bot, computer and generation", () => {
    const key = terminalCollectionKey(scope);
    for (const change of [
      { userId: "another" },
      { spaceId: "another" },
      { botId: "another" },
      { computerId: "another" },
      { generation: 3 },
    ])
      expect(terminalCollectionKey({ ...scope, ...change })).not.toBe(key);
  });
  it.each([
    null,
    [],
    { ...snapshot, version: 2 },
    { ...snapshot, savedAt: NaN },
    { ...snapshot, activeId: "missing" },
    { ...snapshot, sessions: [] },
    { ...snapshot, sessions: [...snapshot.sessions, ...snapshot.sessions] },
    { ...snapshot, sessions: [{ ...snapshot.sessions[0], id: "bad id" }] },
    { ...snapshot, sessions: [{ ...snapshot.sessions[0], cols: 501 }] },
    { ...snapshot, sessions: [{ ...snapshot.sessions[0], rows: 0 }] },
    { ...snapshot, sessions: [{ ...snapshot.sessions[0], number: 0 }] },
    {
      ...snapshot,
      sessions: Array.from({ length: 5 }, (_, index) => ({
        ...snapshot.sessions[0],
        id: `shell-${index}`,
        number: index + 1,
      })),
    },
  ])("rejects malformed or excessive metadata %#", (value) =>
    expect(restoreTerminalCollection(value, 1_001)).toBeNull(),
  );
});
