import type { GoalRevisionView } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { GroupGoalStrip } from "./GroupPanel";

/** The result a board comment names. Loaded with that link, not the initial shell. */
export function GoalNamedResult({
  groupId,
  goalId,
  revisionId,
}: {
  groupId: string;
  goalId: string;
  revisionId: string;
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
  if (!view?.goal.currentRevision || view.goal.currentRevision.id !== revisionId) return null;
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
