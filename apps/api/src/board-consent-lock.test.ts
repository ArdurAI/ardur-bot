import type { BoardScope } from "@ardurbot/adapters";
import { expect, it, vi } from "vitest";
import { updateOwnerBoardItem } from "./board-update.js";

it("takes the filing lock only when close-when-done changes", async () => {
  const update = vi.fn(async () => ({ id: "board-a" }));
  const withFilingLock = vi.fn(async (_scope: BoardScope, work: () => Promise<unknown>) => work());
  const service = {
    provider: vi.fn(async () => ({ update })),
    withFilingLock,
  };
  const actor = { userId: "owner", spaceId: "space" };
  await updateOwnerBoardItem(service, actor, {
    workspaceId: "workspace",
    id: "board-a",
    patch: { title: "Rename" },
  });
  expect(withFilingLock).not.toHaveBeenCalled();
  await updateOwnerBoardItem(service, actor, {
    workspaceId: "workspace",
    id: "board-a",
    patch: { closeWhenDone: false },
  });
  expect(withFilingLock).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith("board-a", { closeWhenDone: false });
});
