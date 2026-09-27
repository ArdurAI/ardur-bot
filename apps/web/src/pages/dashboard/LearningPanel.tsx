import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { rpc } from "../../lib/rpc";
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
      {!data.proposals.length ? (
        <p className="text-muted-foreground">
          <Trans>No proposals</Trans>
        </p>
      ) : null}
      {data.proposals.slice(0, 3).map((proposal) => (
        <Button
          key={proposal.id}
          variant="ghost"
          className="h-auto w-full justify-start whitespace-normal text-start"
          onClick={openLearning}
        >
          {proposal.rationale}
        </Button>
      ))}
    </div>
  );
}
