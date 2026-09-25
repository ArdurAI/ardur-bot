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
  return (
    <div className="space-y-3 text-sm">
      <Button
        variant="link"
        className="h-auto p-0"
        onClick={openLearning}
      >{t`Inbox (${count})`}</Button>
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
