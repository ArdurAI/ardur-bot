import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { rpc } from "../../lib/rpc";
import { learningItemTitle } from "../learning-item-text";
import type { PanelActions, PanelContext } from "./panels";

export async function load(context: PanelContext) {
  return rpc.learning.list({}, { signal: context.signal, context: { spaceId: context.spaceId } });
}
export default function LearningPanel({
  data,
  openLearning,
}: { data: Awaited<ReturnType<typeof load>> } & PanelActions) {
  const { t } = useLingui();
  const count = data.pendingCount;
  const insights = data.insightCount;
  const waiting = data.proposals.filter((proposal) => proposal.status === "pending");
  return (
    <div className="space-y-3 text-sm">
      <div className="flex gap-4">
        <Button
          variant="link"
          className="h-auto p-0"
          onClick={openLearning}
        >{t`Inbox (${count})`}</Button>
        {insights > 0 ? (
          <Button
            variant="link"
            className="h-auto p-0"
            onClick={openLearning}
          >{t`Insights (${insights})`}</Button>
        ) : null}
      </div>
      {!waiting.length && count === 0 ? (
        <p className="text-muted-foreground">
          <Trans>No proposals</Trans>
        </p>
      ) : null}
      {waiting.slice(0, 3).map((proposal) => {
        const title =
          proposal.operation === "revert-suggestion"
            ? t`Possible regression — review undo`
            : proposal.operation === "consolidation"
              ? t`Proposed consolidation`
              : learningItemTitle(proposal);
        return (
          <Button
            key={proposal.id}
            variant="ghost"
            className="h-auto w-full min-w-0 flex-col items-stretch justify-start whitespace-normal text-start"
            onClick={openLearning}
          >
            <span className="block w-full min-w-0 break-words font-medium">{title}</span>
            {proposal.rationale !== title ? (
              <span className="mt-1 block w-full min-w-0 break-words text-xs text-muted-foreground">
                {proposal.rationale}
              </span>
            ) : null}
          </Button>
        );
      })}
    </div>
  );
}
