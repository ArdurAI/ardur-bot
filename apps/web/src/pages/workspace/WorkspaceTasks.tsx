import type { RunActivityRow, WorkspaceTasks as TaskSnapshot } from "@ardurbot/contracts";
import {
  workspaceRunActive,
  workspaceRunQueued,
  workspaceSteerThread,
  workspaceStopStillPending,
  workspaceStopTarget,
  workspaceTaskBuckets,
} from "@ardurbot/core";
import { Button, Textarea } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { statusLabel } from "../../lib/run-status-label";
import { ChatTaskReview } from "../ChatTaskReview";

export function WorkspaceTasks({
  botId,
  visible,
  onOpenRun,
}: {
  botId: string;
  visible: boolean;
  onOpenRun(run: RunActivityRow): void;
}) {
  const { t } = useLingui();
  const formatRelativeTime = (iso: string) => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (!Number.isFinite(seconds)) return "";
    if (seconds < 45) return t`just now`;
    if (seconds < 3600) return t`${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400) return t`${Math.floor(seconds / 3600)}h ago`;
    return t`${Math.floor(seconds / 86_400)}d ago`;
  };
  const [snapshot, setSnapshot] = useState<TaskSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [steering, setSteering] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<RunActivityRow | null>(null);
  const refresh = useCallback(async () => {
    try {
      const result = await rpc.workspace.tasks({ botId });
      setSnapshot(result);
      setStopping(
        (current) => new Set([...current].filter((id) => workspaceStopStillPending(result, id))),
      );
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [botId]);
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      await refresh();
      if (!stopped) timer = window.setTimeout(() => void tick(), 15_000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [refresh, visible]);
  if (!snapshot)
    return (
      <p role="status" className="p-3 text-sm text-muted-foreground">
        {failed ? t`Could not refresh tasks` : t`Loading tasks…`}
      </p>
    );
  const {
    running: ownRunning,
    queued: ownWaiting,
    recent,
    delegatedRuns,
    delegations: delegated,
  } = workspaceTaskBuckets(snapshot, botId);
  const routineName = new Map(snapshot.routines.map((routine) => [routine.id, routine.name]));
  const mutate = async (id: string, work: () => Promise<unknown>) => {
    setPending(id);
    try {
      await work();
      await refresh();
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setPending(null);
    }
  };
  const stop = async (id: string, work: () => Promise<unknown>) => {
    setStopping((current) => new Set(current).add(id));
    if (!(await mutate(id, work)))
      setStopping((current) => new Set([...current].filter((item) => item !== id)));
  };
  const row = (run: TaskSnapshot["runs"][number]) => {
    const title = run.routineId ? routineName.get(run.routineId) : null;
    const stopTarget = workspaceStopTarget(run, botId);
    const steerThread = workspaceSteerThread(run, botId);
    return (
      <div key={run.runId} className="border-b border-border px-3 py-2 text-sm">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 truncate font-medium" title={run.promptSnippet}>
            {title || run.promptSnippet || run.botName}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {stopping.has(run.runId) ? t`Stopping` : statusLabel(run.status)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {run.botName} · {formatRelativeTime(run.startedAt ?? run.createdAt ?? run.updatedAt)}
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => (run.externalThread ? setReview(run) : onOpenRun(run))}
          >{t`Open conversation`}</Button>
          {workspaceRunActive(run) || workspaceRunQueued(run) ? (
            <>
              {steerThread ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setSteering(run.runId);
                    setText("");
                  }}
                >{t`Steer`}</Button>
              ) : null}
              {stopTarget?.kind === "delegation" ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={stopping.has(run.runId)}
                  onClick={() =>
                    void stop(run.runId, () =>
                      rpc.delegations.cancel({ rootTaskId: stopTarget.id }),
                    )
                  }
                >{t`Stop delegated work`}</Button>
              ) : stopTarget?.kind === "thread" ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={stopping.has(run.runId)}
                  onClick={() =>
                    void stop(run.runId, () => rpc.threads.stop({ threadId: stopTarget.id }))
                  }
                >{t`Stop work in this conversation`}</Button>
              ) : null}
            </>
          ) : null}
        </div>
        {steering === run.runId ? (
          <form
            className="mt-2 space-y-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (!text.trim()) return;
              void mutate(run.runId, () =>
                rpc.threads.followUp({
                  threadId: steerThread!,
                  text: text.trim(),
                }),
              ).then((success) => {
                if (success) {
                  setSteering(null);
                  setText("");
                }
              });
            }}
          >
            <Textarea
              aria-label={t`Steer work`}
              value={text}
              maxLength={2000}
              onChange={(event) => setText(event.target.value)}
            />
            <Button
              size="xs"
              type="submit"
              disabled={!text.trim() || pending === run.runId}
            >{t`Send follow-up`}</Button>
            <Button
              size="xs"
              variant="ghost"
              type="button"
              onClick={() => setSteering(null)}
            >{t`Cancel`}</Button>
          </form>
        ) : null}
      </div>
    );
  };
  return (
    <div className="text-foreground" data-testid="workspace-tasks">
      {review ? <ChatTaskReview run={review} onClose={() => setReview(null)} /> : null}
      {failed ? (
        <div
          role="status"
          className="flex items-center justify-between px-3 py-2 text-xs text-warning"
        >
          {t`Could not refresh tasks`}
          <Button size="xs" variant="ghost" onClick={() => void refresh()}>{t`Retry`}</Button>
        </div>
      ) : null}
      {!ownRunning.length && !ownWaiting.length ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">{t`Nothing running or queued`}</p>
      ) : null}
      {ownRunning.length ? (
        <section>
          <h3 className="px-3 py-2 text-xs font-medium text-muted-foreground">{t`Running`}</h3>
          {ownRunning.map((run) => row(run))}
        </section>
      ) : null}
      {ownWaiting.length ? (
        <section>
          <h3 className="px-3 py-2 text-xs font-medium text-muted-foreground">{t`Queued`}</h3>
          {ownWaiting.map((run) => row(run))}
        </section>
      ) : null}
      <section>
        <h3 className="px-3 py-2 text-xs font-medium text-muted-foreground">{t`Delegated`}</h3>
        {delegatedRuns.map((run) => row(run))}
        {delegated.length ? (
          delegated.map((item) => (
            <div key={item.id} className="border-b border-border px-3 py-2 text-sm">
              <div className="flex justify-between gap-2">
                <span className="truncate font-medium">{item.card?.goal ?? item.actingName}</span>
                <span className="text-xs text-muted-foreground">
                  {stopping.has(item.id) || item.status === "cancel-requested"
                    ? t`Stopping`
                    : item.status}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{item.actingName}</p>
              {["queued", "running", "cancel-requested"].includes(item.status) ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={stopping.has(item.id)}
                  onClick={() =>
                    void stop(item.id, () =>
                      rpc.delegations.cancel({ rootTaskId: item.rootTaskId }),
                    )
                  }
                >{t`Stop delegated work`}</Button>
              ) : null}
            </div>
          ))
        ) : !delegatedRuns.length ? (
          <p className="px-3 pb-2 text-sm text-muted-foreground">{t`No delegated work`}</p>
        ) : null}
      </section>
      {recent.length ? (
        <section>
          <h3 className="px-3 py-2 text-xs font-medium text-muted-foreground">{t`Recent`}</h3>
          {recent.map((run) => row(run))}
        </section>
      ) : null}
    </div>
  );
}
