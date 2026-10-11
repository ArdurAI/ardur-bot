import type { Goal } from "@ardurbot/contracts";
import { boardItemPath } from "@ardurbot/contracts";
import { Trans } from "@lingui/react/macro";

/** Board link for a goal. Loaded only with the goal page, not the initial shell. */
export function GoalBoardLink({ goal }: { goal: Goal }) {
  if (!goal.boardWorkspaceId || !goal.boardItemId) return null;
  return (
    <p className="pb-2">
      <Trans>Board item</Trans>{" "}
      <a href={boardItemPath(goal.boardWorkspaceId, goal.boardItemId)}>
        <Trans>Open board item</Trans>
      </a>
      {goal.boardDelivery && goal.boardDelivery !== "delivered" ? (
        <>
          {" "}
          · <Trans>Board update pending</Trans>
        </>
      ) : null}
    </p>
  );
}
