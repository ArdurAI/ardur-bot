import type { GoalRevisionView } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { GroupGoalStrip } from "./GroupPanel";

/**
 * The result a board comment names. Loaded with that link, not the initial shell.
 * A stale or unknown link falls back to the group's live goal strip so the normal
 * goal view is never hidden by a result link that no longer resolves.
 */
export function GoalNamedResult({
  groupId,
  goalId,
  revisionId,
  fallback = null,
}: {
  groupId: string;
  goalId: string;
  revisionId: string;
  fallback?: ReactNode;
}) {
  const [view, setView] = useState<GoalRevisionView | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setView(undefined);
    void rpc.goals
      .revision({ groupId, goalId, revisionId })
      .then((value) => {
        if (live) setView(value);
      })
      .catch(() => {
        if (live) setView(null);
      });
    return () => {
      live = false;
    };
  }, [groupId, goalId, revisionId]);
  if (view === undefined) return null;
  if (!view?.goal.currentRevision || view.goal.currentRevision.id !== revisionId) return fallback;
  const shown = view;
  return (
    <GroupGoalStrip
      goal={shown.goal}
      openReview
      recordedResult={!shown.current || shown.goal.status !== "completed"}
      onRefresh={async () => {
        setView(await rpc.goals.revision({ groupId, goalId, revisionId }));
      }}
      onStop={async () => {
        await rpc.goals.stop({ goalId: shown.goal.id });
        setView(await rpc.goals.revision({ groupId, goalId, revisionId }));
      }}
    />
  );
}
