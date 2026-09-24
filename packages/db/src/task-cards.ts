import { randomUUID } from "node:crypto";
import type { TaskCard, TaskEvent } from "@ardurbot/contracts";
import {
  TaskArtifactSchema,
  TaskCardSchema,
  TaskCompletionSchema,
  TaskProgressSchema,
} from "@ardurbot/contracts";
import { redactTaskValue } from "@ardurbot/core";
import type { Delegation, Prisma } from "./client.js";
import { finishDelegation } from "./delegation.js";
import { appendEventInTransaction } from "./events.js";

export async function validateTaskReferences(
  tx: Prisma.TransactionClient,
  scope: { spaceId: string; userId: string },
  card: Pick<TaskCard, "inputs">,
) {
  for (const input of card.inputs) {
    if (input.type === "file")
      await tx.artifact.findFirstOrThrow({ where: { id: input.artifactId, ...scope } });
    if (input.type === "document")
      await tx.memoryRevision.findFirstOrThrow({
        where: {
          documentId: input.documentId,
          revision: input.revision,
          deletedAt: null,
          document: { spaceId: scope.spaceId, userId: scope.userId },
        },
      });
  }
}

/** The caller holds the root-task lock. Events are quiet, persisted thread events. */
export async function appendTaskEvent(
  tx: Prisma.TransactionClient,
  row: Delegation,
  kind: TaskEvent["kind"],
  text = "",
  options: { id?: string; action?: string; card?: TaskCard } = {},
) {
  if (!row.card) return;
  const card = options.card ?? TaskCardSchema.parse(row.card);
  const id = options.id ?? randomUUID();
  if (card.timeline.some((event) => event.id === id)) return;
  if (
    (kind === "progress" || kind === "artifact" || kind === "blocked") &&
    card.timeline.length >= 180
  )
    throw new Error("This card has reached its update limit; complete the task.");
  const event: TaskEvent = {
    id,
    kind,
    at: new Date().toISOString(),
    text: redactTaskValue(text).slice(0, 2000),
    ...(options.action ? { action: redactTaskValue(options.action).slice(0, 200) } : {}),
  };
  const next = TaskCardSchema.parse({ ...card, timeline: [...card.timeline, event].slice(-200) });
  await tx.delegation.update({ where: { id: row.id }, data: { card: next } });
  const root = await tx.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: row.rootTaskId } });
  return appendEventInTransaction(tx, {
    spaceId: row.spaceId,
    threadId: root.coordinatorThreadId,
    botId: root.coordinatorBotId,
    ...(row.runId ? { runId: row.runId } : {}),
    type: "delegation.progress",
    payload: { delegationId: row.id, ...event },
  });
}

export async function startDelegation(
  tx: Prisma.TransactionClient,
  id: string,
  executionKey?: string,
) {
  let row = await tx.delegation.findUniqueOrThrow({ where: { id } });
  await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${row.rootTaskId} FOR UPDATE`;
  row = await tx.delegation.findUniqueOrThrow({ where: { id } });
  if (row.status !== "queued" && !(row.status === "running" && executionKey)) return;
  if (row.status === "queued")
    await tx.delegation.update({ where: { id }, data: { status: "running" } });
  await appendTaskEvent(
    tx,
    row,
    "started",
    "",
    executionKey ? { id: `started:${executionKey}` } : {},
  );
}

export async function updateWorkerTask(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    spaceId: string;
    userId: string;
    botId: string;
    delegationId?: string;
    executionId: string;
    tool: string;
    args: unknown;
  },
) {
  let run = await tx.run.findFirstOrThrow({
    where: { id: input.runId, spaceId: input.spaceId, userId: input.userId, botId: input.botId },
  });
  const id = input.delegationId ?? run.delegationId;
  if (!id) throw new Error("There is no delegated task in this run.");
  let row = await tx.delegation.findFirstOrThrow({
    where: { id, spaceId: input.spaceId, userId: input.userId, actingBotId: input.botId },
  });
  await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${row.rootTaskId} FOR UPDATE`;
  row = await tx.delegation.findUniqueOrThrow({ where: { id } });
  if (input.delegationId && (row.kind !== "helper" || row.parentRunId !== run.id))
    throw new Error("This helper does not belong to this run.");
  run = await tx.run.findFirstOrThrow({
    where: { id: input.runId, spaceId: input.spaceId, userId: input.userId, botId: input.botId },
  });
  const card = TaskCardSchema.parse(row.card);
  if (card.timeline.some((event) => event.id === input.executionId)) return { ok: true };
  if (
    run.status !== "running" ||
    run.cancelRequestedAt ||
    row.status !== "running" ||
    row.deadlineAt <= new Date()
  )
    throw new Error("This task is no longer working.");
  const args = redactTaskValue(input.args);
  let event: Awaited<ReturnType<typeof appendTaskEvent>>;
  if (input.tool === "report_progress") {
    const update = TaskProgressSchema.parse(args);
    event = await appendTaskEvent(tx, row, update.state, update.text, {
      id: input.executionId,
      action: update.action,
    });
  } else if (input.tool === "attach_artifact") {
    const { artifactId } = TaskArtifactSchema.parse(args);
    await tx.artifact.findFirstOrThrow({
      where: { id: artifactId, spaceId: row.spaceId, userId: row.userId, runId: run.id },
    });
    if (!card.artifacts.includes(artifactId)) card.artifacts.push(artifactId);
    event = await appendTaskEvent(tx, row, "artifact", artifactId, { id: input.executionId, card });
  } else if (input.tool === "complete_task") {
    const result = TaskCompletionSchema.parse(args);
    if (
      result.reports.length !== card.doneWhen.length ||
      new Set(result.reports.map((report) => report.index)).size !== card.doneWhen.length ||
      result.reports.some((report) => report.index >= card.doneWhen.length)
    )
      throw new Error("Report once against every definition-of-done item.");
    // A worker cannot complete around a pending consequential-effect approval.
    const waiting = await tx.externalEffect.findFirst({
      where: { runId: run.id, status: "intended" },
    });
    if (waiting) throw new Error("This task is waiting for approval.");
    card.reports = result.reports;
    await tx.delegation.update({ where: { id }, data: { card } });
    event = await finishDelegation(tx, id, "completed", result.summary, row.runId);
  } else throw new Error("Unknown task-card update.");
  return { ok: true, event };
}
