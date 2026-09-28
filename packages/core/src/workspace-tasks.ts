import type { WorkspaceTasks } from "@ardurbot/contracts";

type Run = WorkspaceTasks["runs"][number];

export function workspaceRunActive(run: Run): boolean {
  return (
    run.status === "running" || run.status === "waiting_input" || run.status === "waiting_takeover"
  );
}

export function workspaceRunQueued(run: Run): boolean {
  return run.status === "queued" || run.status === "leased";
}

export function workspaceTaskBuckets(snapshot: WorkspaceTasks, botId: string) {
  const own = snapshot.runs.filter((run) => run.botId === botId);
  const delegatedRuns = snapshot.runs.filter((run) => run.botId !== botId);
  return {
    running: own.filter(workspaceRunActive),
    queued: own.filter(workspaceRunQueued),
    recent: own.filter((run) => !workspaceRunActive(run) && !workspaceRunQueued(run)),
    delegatedRuns,
    delegations: snapshot.delegations.filter(
      (item) => !delegatedRuns.some((run) => run.runId === item.runId),
    ),
  };
}

export function workspaceStopTarget(run: Run, selectedBotId: string) {
  if (run.botId === selectedBotId) return { kind: "thread" as const, id: run.threadId };
  return run.rootTaskId ? { kind: "delegation" as const, id: run.rootTaskId } : null;
}

export function workspaceSteerThread(run: Run, selectedBotId: string): string | null {
  return run.botId === selectedBotId ? run.threadId : run.coordinatorThreadId;
}

export function workspaceStopStillPending(snapshot: WorkspaceTasks, id: string): boolean {
  const run = snapshot.runs.find((item) => item.runId === id);
  if (run) return workspaceRunActive(run) || workspaceRunQueued(run);
  const delegation = snapshot.delegations.find((item) => item.id === id);
  return Boolean(
    delegation && ["queued", "running", "cancel-requested"].includes(delegation.status),
  );
}
