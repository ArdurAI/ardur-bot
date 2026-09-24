import { runContinueJob } from "@ardurbot/adapter-kit";
import { redactTaskValue } from "@ardurbot/core";
import { rejectDelegation, updateWorkerTask, withTransactionRetry } from "@ardurbot/db";
import { delegationFailure } from "./delegation.js";
import type { ExecutorDeps } from "./executor.js";

export async function rejectTask(
  deps: Pick<ExecutorDeps, "prisma" | "jobs">,
  run: { spaceId: string; userId: string; botId: string },
  id: string,
  reason: string,
  secrets: readonly string[],
) {
  const result = await withTransactionRetry(() =>
    deps.prisma.$transaction((tx) =>
      rejectDelegation(tx, run, id, run.botId, redactTaskValue(reason, secrets)),
    ),
  ).catch(delegationFailure);
  if (result.ok) await deps.jobs.enqueue(runContinueJob(result.runId)).catch(() => undefined);
  return result;
}

export async function updateTaskCard(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  input: Parameters<typeof updateWorkerTask>[1],
) {
  const result = await deps.prisma.$transaction((tx) => updateWorkerTask(tx, input));
  if ("event" in result && result.event)
    await deps.events.notify(result.event.threadId, result.event.seq).catch(() => undefined);
  return { ok: true };
}
