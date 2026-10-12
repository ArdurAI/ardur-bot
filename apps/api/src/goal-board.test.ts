import type { Actor } from "@ardurbot/contracts";
import { BoardError } from "@ardurbot/contracts/board";
import { IsolationError } from "@ardurbot/db";
import { expect, it } from "vitest";
import { authorizeGoalBoardLink } from "./goal-board.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};

function board(options: {
  spaceId?: string;
  ownerUserId?: string;
  itemId?: string | null;
  actor?: () => Promise<string>;
}) {
  return {
    actor: options.actor ?? (async () => "Owner"),
    workspace: async () => ({
      id: "workspace",
      spaceId: options.spaceId ?? "space",
      ownerUserId: options.ownerUserId ?? "owner",
    }),
    provider: async () => ({
      show: async () => {
        if (!options.itemId) throw new BoardError({ code: "item_not_found", message: "missing" });
        return { id: options.itemId };
      },
    }),
  };
}

it("stores the looked-up workspace and item for the owner", async () => {
  await expect(
    authorizeGoalBoardLink(
      actor,
      { workspaceId: "workspace", itemId: "board-a" },
      board({ itemId: "board-a" }) as never,
    ),
  ).resolves.toEqual({ workspaceId: "workspace", itemId: "board-a" });
});

it("refuses a non-owner, another space, and a missing item", async () => {
  await expect(
    authorizeGoalBoardLink(
      { ...actor, isDeploymentOwner: false },
      { workspaceId: "workspace", itemId: "board-a" },
      board({ itemId: "board-a" }) as never,
    ),
  ).rejects.toBeInstanceOf(IsolationError);
  await expect(
    authorizeGoalBoardLink(
      actor,
      { workspaceId: "workspace", itemId: "board-a" },
      board({ itemId: "board-a", spaceId: "other" }) as never,
    ),
  ).rejects.toBeInstanceOf(IsolationError);
  await expect(
    authorizeGoalBoardLink(
      actor,
      { workspaceId: "workspace", itemId: "board-a" },
      board({ itemId: "board-a", ownerUserId: "other" }) as never,
    ),
  ).rejects.toBeInstanceOf(IsolationError);
  await expect(
    authorizeGoalBoardLink(
      actor,
      { workspaceId: "workspace", itemId: "board-a" },
      board({ itemId: null }) as never,
    ),
  ).rejects.toBeInstanceOf(BoardError);
});
