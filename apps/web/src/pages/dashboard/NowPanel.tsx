import type { RunActivityRow } from "@ardurbot/contracts";
import { activeDelegations } from "@ardurbot/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { lazy, Suspense, useState } from "react";
import { Link } from "react-router-dom";
import { AskCard } from "../../components/AskCard";
import { rpc } from "../../lib/rpc";
import type { PanelActions, PanelContext } from "./panels";

const ChatTaskReview = lazy(() =>
  import("../ChatTaskReview").then((module) => ({ default: module.ChatTaskReview })),
);

function target(run: RunActivityRow) {
  const owner = run.approvalTarget ?? run;
  return owner.groupId
    ? { groupId: owner.groupId }
    : { botId: owner.botId, threadId: owner.threadId };
}
export async function load(context: PanelContext) {
  const summary = await rpc.dashboard.now(undefined, {
    signal: context.signal,
    context: { spaceId: context.spaceId },
  });
  return { ...summary, spaceId: context.spaceId };
}
export default function NowPanel({
  data,
  refresh,
}: { data: Awaited<ReturnType<typeof load>> } & PanelActions) {
  const { t } = useLingui();
  const [review, setReview] = useState<RunActivityRow | null>(null);
  const delegations = activeDelegations(data.rows);
  return (
    <div className="space-y-3 text-sm">
      {review ? (
        <Suspense fallback={null}>
          <ChatTaskReview run={review} onClose={() => setReview(null)} />
        </Suspense>
      ) : null}
      {!data.runs.length && !delegations.length ? (
        <p className="text-muted-foreground">
          <Trans>Nothing running</Trans>
        </p>
      ) : null}
      {data.runs.map((run) => {
        const started = run.startedAt ?? run.createdAt;
        const seconds = started
          ? Math.max(0, Math.floor((Date.now() - Date.parse(started)) / 1000))
          : null;
        const label = (
          <>
            <span className="font-medium">{run.botName}</span>
            <span className="min-w-0 flex-1 truncate">{run.promptSnippet}</span>
            {seconds !== null ? (
              <span className="tabular-nums text-muted-foreground">{t`${seconds}s`}</span>
            ) : null}
          </>
        );
        return (
          <div key={run.runId} className="border-b border-border pb-3 last:border-0">
            {run.externalThread ? (
              <button
                type="button"
                className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 text-left hover:underline"
                onClick={() => setReview(run)}
              >
                {label}
              </button>
            ) : (
              <Link
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 hover:underline"
                to={run.groupId ? `/app/g/${run.groupId}` : `/app/${run.botId}`}
              >
                {label}
              </Link>
            )}
            {data.approvals
              .filter((approval) => approval.runId === run.runId)
              .map((approval, index) =>
                approval.block.kind === "ask" ? (
                  <div className="mt-2" key={`${approval.messageId}:${index}`}>
                    <p className="mb-2">
                      <Trans>Waiting for your approval</Trans>
                    </p>
                    <AskCard
                      block={approval.block}
                      canAnswer
                      onAnswer={async (answer) => {
                        await rpc.threads.answer(
                          {
                            ...target(run),
                            runId: run.runId,
                            messageId: approval.messageId,
                            answer,
                          },
                          { context: { spaceId: data.spaceId } },
                        );
                        await refresh();
                      }}
                    />
                  </div>
                ) : null,
              )}
          </div>
        );
      })}
      {delegations.map((delegation) => (
        <Link
          key={delegation.id}
          to={`/app/${delegation.actingBotId}`}
          className="block rounded-lg bg-muted p-3 hover:underline"
        >
          <span>{delegation.card?.goal ?? delegation.rootTaskId}</span>
          {" · "}
          <span>{delegation.actingName}</span>
          {" · "}
          <span>
            {delegation.status === "queued"
              ? t`Queued`
              : delegation.status === "cancel-requested"
                ? t`Stopping`
                : t`Working`}
          </span>
        </Link>
      ))}
    </div>
  );
}
