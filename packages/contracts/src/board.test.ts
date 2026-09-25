import { expect, it } from "vitest";
import type { WorkItem } from "./board.js";
import { BoardConfigurationSchema, BoardWorkspaceSchema, boardColumn } from "./board.js";

it("keeps existing workspace payloads compatible and validates configuration", () => {
  expect(
    BoardWorkspaceSchema.parse({
      id: "board",
      kind: "space",
      path: "/fixture/board",
      prefix: "work",
      name: "Work",
      initialized: true,
      enabled: true,
    }),
  ).toMatchObject({ isDefault: false, allowAllBots: true, allowedBotIds: [] });
  expect(BoardConfigurationSchema.safeParse({ name: "" }).success).toBe(false);
  expect(BoardConfigurationSchema.safeParse({ isDefault: false }).success).toBe(false);
});
it("projects identical columns from RPC arrays and indexed membership for long boards", () => {
  const array = { readyIds: ["ready"], blockedIds: ["dependent"] };
  const indexed = { readyIds: new Set(array.readyIds), blockedIds: new Set(array.blockedIds) };
  const now = Date.parse("2026-09-25T12:00:00Z");
  for (const [id, status, expected] of [
    ["ready", "open", "ready"],
    ["dependent", "open", "blocked"],
    ["working", "hooked", "in_progress"],
    ["waiting", "pinned", "deferred"],
    ["done", "closed", "done"],
  ]) {
    const item = { id, status, deferUntil: null, closedAt: "2026-09-25T11:00:00Z" } as WorkItem;
    expect(boardColumn(item, array, now)).toBe(expected);
    expect(boardColumn(item, indexed, now)).toBe(expected);
  }
});
