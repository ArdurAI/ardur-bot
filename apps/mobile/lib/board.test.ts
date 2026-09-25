import { expect, it, vi } from "vitest";
import { rpc } from "./api";
import { boardProblemText, loadBoardItem, loadBoardReady } from "./board";
import { activateUiLocale, t } from "./i18n";

vi.mock("./api", () => ({ rpc: vi.fn() }));
const item = {
  id: "board-a",
  title: "Ready work",
  description: "Read details",
  acceptanceCriteria: "Check results",
  type: "task",
  status: "open",
  priority: 2,
  assignee: null,
  labels: [],
  parent: null,
  dependencies: [],
  dueAt: null,
  deferUntil: null,
  estimateMinutes: null,
  externalRef: null,
  createdAt: "",
  updatedAt: "",
  closedAt: null,
  commentCount: 0,
  comments: [],
  history: [],
  closeWhenDone: false,
};
it("loads only ready items and validates the read-only item response", async () => {
  vi.mocked(rpc)
    .mockResolvedValueOnce({
      items: [item, { ...item, id: "blocked" }],
      readyIds: [item.id],
      blockedIds: ["blocked"],
    })
    .mockResolvedValueOnce(item);
  expect(await loadBoardReady("workspace")).toEqual([item]);
  expect(await loadBoardItem("workspace", item.id)).toEqual(item);
  expect(rpc).toHaveBeenCalledWith("board/snapshot", { workspaceId: "workspace" });
  expect(rpc).toHaveBeenCalledWith("board/show", { workspaceId: "workspace", id: item.id });
});
it.each(["zh-CN", "ru"] as const)(
  "translates every Board label and version error in %s",
  (locale) => {
    activateUiLocale(locale);
    try {
      for (const message of [
        "Board",
        "Ready",
        "Blocks",
        "Blocked by",
        "Acceptance criteria",
        "Retry",
        "Could not load Board; retry.",
        "Beads is not installed on this computer",
        "This folder has no board",
        "Another write is in progress",
        "The board command timed out.",
        "Dolt is not installed on this computer.",
      ])
        expect(t(message)).not.toBe(message);
      const message = boardProblemText(
        { code: "unsupported_version", message: "Beads version 0.59.0 is not supported yet" },
        t,
      );
      expect(message).toContain("0.59.0");
      expect(message).not.toContain("is not supported yet");
    } finally {
      activateUiLocale("en");
    }
  },
);
