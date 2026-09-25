import type { RunActivityRow } from "@ardurbot/contracts";
import { activeDelegations, isApprovalAskBlock } from "@ardurbot/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "react-router-dom";
import type { AskBlock } from "../../components/AskCard";
import { AskCard } from "../../components/AskCard";
import { rpc } from "../../lib/rpc";
import type { PanelActions, PanelContext } from "./panels";
import { useThreadRefresh } from "./use-thread-refresh";

function target(run: RunActivityRow) {
  const owner = run.approvalTarget ?? run;
  return owner.groupId
    ? { groupId: owner.groupId }
    : { botId: owner.botId, threadId: owner.threadId };
}
export async function load(context: PanelContext) {
  const options = { signal: context.signal, context: { spaceId: context.spaceId } };
  const [board, activity] = await Promise.all([
    rpc.team.board({}, options),
    rpc.runs.list({ filter: "active" }, options),
  ]);
  const approvals = (
    await Promise.all(
      activity.runs
        .filter((run) => run.status === "waiting_input")
        .map(async (run) => {
          const snapshot = await rpc.threads.get(target(run), options);
          const active = snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []);
          // Delegated cards live in the coordinator thread, while its child run
          // remains in the worker thread. runs.list supplies that waiting state.
          if (
            !run.approvalTarget &&
            !active.some((entry) => entry.id === run.runId && entry.status === "waiting_input")
          )
            return [];
          return snapshot.messages
            .filter((message) => message.runId === run.runId)
            .flatMap((message) =>
              message.blocks
                .filter(
                  (block): block is AskBlock =>
                    block.kind === "ask" &&
                    block.status !== "answered" &&
                    isApprovalAskBlock(block),
                )
                .map((block) => ({ run, messageId: message.id, block })),
            );
        }),
    )
  ).flat();
  return { rows: board.rows, runs: activity.runs, approvals, spaceId: context.spaceId };
}
export default function NowPanel({
  data,
  refresh,
}: { data: Awaited<ReturnType<typeof load>> } & PanelActions) {
  const { t } = useLingui();
  useThreadRefresh(data.rows, refresh);
  const delegations = activeDelegations(data.rows);
  return (
    <div className="space-y-3 text-sm">
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
        return (
          <div key={run.runId} className="border-b border-border pb-3 last:border-0">
            <Link
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 hover:underline"
              to={`/app/${run.botId}`}
            >
              <span className="font-medium">{run.botName}</span>
              <span className="min-w-0 flex-1 truncate">{run.promptSnippet}</span>
              {seconds !== null ? (
                <span className="tabular-nums text-muted-foreground">{t`${seconds}s`}</span>
              ) : null}
            </Link>
            {data.approvals
              .filter((approval) => approval.run.runId === run.runId)
              .map((approval, index) => (
                <div className="mt-2" key={`${approval.messageId}:${index}`}>
                  <p className="mb-2">
                    <Trans>Waiting for your approval</Trans>
                  </p>
                  <AskCard
                    block={approval.block}
                    canAnswer
                    onAnswer={async (answer) => {
                      await rpc.threads.answer(
                        { ...target(run), runId: run.runId, messageId: approval.messageId, answer },
                        { context: { spaceId: data.spaceId } },
                      );
                      await refresh();
                    }}
                  />
                </div>
              ))}
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
