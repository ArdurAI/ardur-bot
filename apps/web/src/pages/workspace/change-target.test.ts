import type { IdeChange } from "@ardurbot/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { readWorkspaceChange } from "./change-target";

const changes = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({ rpc: { ide: { changes } } }));
const target = { botId: "bot", rootId: "root", computerId: "computer", generation: 1 };
const location = {
  changeId: "record",
  since: "2026-10-01T00:00:00Z",
  until: "2026-10-02T00:00:00Z",
};
const item = { id: "record", botId: "bot", path: "notes.md" } as IdeChange;
beforeEach(() => {
  changes.mockReset();
});
it("pages through checked history until the exact bot's change is found", async () => {
  changes.mockResolvedValueOnce({ items: [], nextCursor: "older" });
  changes.mockResolvedValueOnce({ items: [item], nextCursor: null });
  expect(await readWorkspaceChange(target, location, new AbortController().signal)).toEqual(item);
  expect(changes.mock.calls.map(([input]) => input)).toEqual([
    { ...location, target, rootId: "root", cursor: undefined },
    { ...location, target, rootId: "root", cursor: "older" },
  ]);
});
it("refuses a missing, cross-bot, or stale target instead of opening a different record", async () => {
  changes.mockResolvedValue({ items: [{ ...item, botId: "other" }], nextCursor: null });
  await expect(readWorkspaceChange(target, location, new AbortController().signal)).rejects.toThrow(
    "Resource not found",
  );
  changes.mockRejectedValue(new Error("Computer changed. Refresh files."));
  await expect(readWorkspaceChange(target, location, new AbortController().signal)).rejects.toThrow(
    "Computer changed. Refresh files.",
  );
});
it("refuses a late selection and stops repeated cursors", async () => {
  const abort = new AbortController();
  changes.mockImplementation(async () => {
    abort.abort();
    return { items: [item], nextCursor: null };
  });
  await expect(readWorkspaceChange(target, location, abort.signal)).rejects.toThrow("Cancelled");
  changes.mockResolvedValue({ items: [], nextCursor: "same" });
  await expect(readWorkspaceChange(target, location, new AbortController().signal)).rejects.toThrow(
    "Resource not found",
  );
});
