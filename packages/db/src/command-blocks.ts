import type { CommandBlock, ThreadMessage } from "@ardurbot/contracts";
import { CommandEventPayloadSchema, ToolResumedPayloadSchema } from "@ardurbot/contracts";
import {
  commandCardId,
  commandJoins,
  commandRecordingIsLive,
  isCommandEvent,
  nextCommandCard,
  projectCommandBlocks,
  resumeCommandCard,
  resumedCardIds,
  settleCommandBlock,
} from "@ardurbot/core";
import type { Prisma, PrismaClient } from "./client.js";

type Db = PrismaClient | Prisma.TransactionClient;

type StoredEvent = {
  id: string;
  type: string;
  payload: unknown;
  threadId: string;
  botId: string;
  runId: string | null;
};

/** Materialized thread row; ordered command events remain the source of truth. */
export async function materializeCommandEvent(tx: Prisma.TransactionClient, event: StoredEvent) {
  if (event.type === "agent.tool.resumed") return materializeResumedCall(tx, event);
  if (!isCommandEvent(event.type)) return;
  const { block } = CommandEventPayloadSchema.parse(event.payload);
  const id = commandCardId(
    block.commandId,
    commandJoins(await resumeLinks(tx, event, block.commandId), block.commandId),
  );
  // A command id a resumed call took over stays stored as evidence only.
  if (!id) return;
  const row = await tx.message.findUnique({ where: { id }, select: { id: true, blocks: true } });
  const [card] = (row?.blocks ?? []) as MessageBlocks;
  const command = nextCommandCard(id, card?.kind === "command" ? card.command : undefined, block);
  // A late event from an attempt that lost the lease stays stored as evidence only.
  if (!command) return;
  if (row) {
    await tx.message.update({
      where: { id },
      data: { blocks: [{ kind: "command", command }] as Prisma.InputJsonValue },
    });
    return;
  }
  const thread = await tx.thread.update({
    where: { id: event.threadId },
    data: { nextMessageSeq: { increment: 1 } },
    select: { nextMessageSeq: true },
  });
  await tx.message.create({
    data: {
      id,
      threadId: event.threadId,
      botId: event.botId,
      runId: event.runId,
      role: "bot",
      seq: thread.nextMessageSeq - 1,
      blocks: [{ kind: "command", command }] as Prisma.InputJsonValue,
    },
  });
}

type MessageBlocks = ThreadMessage["blocks"];

/** The run's resume links, other than `except`, that name `commandId` on either side. */
async function resumeLinks(
  tx: Prisma.TransactionClient,
  event: Pick<StoredEvent, "threadId" | "runId">,
  commandId: string,
  except?: string,
) {
  if (!event.runId) return [];
  const links = await tx.event.findMany({
    where: {
      threadId: event.threadId,
      runId: event.runId,
      type: "agent.tool.resumed",
      ...(except ? { id: { not: except } } : {}),
      OR: [
        { payload: { path: ["fromCommandId"], equals: commandId } },
        { payload: { path: ["toCommandId"], equals: commandId } },
      ],
    },
    select: { payload: true },
  });
  return links.map((link) => link.payload);
}

/** The killed call's card row is renamed for the call that resumes it; no other row changes. */
async function materializeResumedCall(tx: Prisma.TransactionClient, event: StoredEvent) {
  const link = ToolResumedPayloadSchema.safeParse(event.payload);
  if (!link.success || !link.data.fromCommandId) return;
  const prior = await resumeLinks(tx, event, link.data.fromCommandId, event.id);
  const ids = resumedCardIds(link.data, (commandId) => commandJoins(prior, commandId));
  if (!ids || (await tx.message.findUnique({ where: { id: ids.to }, select: { id: true } })))
    return;
  const row = await tx.message.findUnique({
    where: { id: ids.from },
    select: { id: true, blocks: true },
  });
  if (!row) return;
  const blocks = (row.blocks as MessageBlocks).map((block) =>
    block.kind === "command"
      ? { kind: "command" as const, command: resumeCommandCard(block.command, ids.fromCommandId) }
      : block,
  );
  await tx.message.update({
    where: { id: ids.from },
    data: { id: ids.to, blocks: blocks as Prisma.InputJsonValue },
  });
}

/**
 * Every commandId a run's `command.finished` events name, so re-leasing can skip an already
 * settled card without loading any finished command's stdout/stderr payload.
 */
export async function finishedCommandIds(db: Db, runId: string): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ commandId: string | null }[]>`
    SELECT payload->'block'->>'commandId' AS "commandId"
    FROM events
    WHERE "runId" = ${runId} AND type = 'command.finished'`;
  return new Set(rows.flatMap((row) => (row.commandId ? [row.commandId] : [])));
}

/** A stale lease or a later attempt must never present an interrupted command as live. */
export async function hydrateCommandMessages(
  db: Db,
  messages: ThreadMessage[],
): Promise<ThreadMessage[]> {
  const commandBlocks = messages.flatMap((message) =>
    message.blocks.flatMap((block) => (block.kind === "command" ? [block.command] : [])),
  );
  if (!commandBlocks.length) return messages;
  const runs = await db.run.findMany({
    where: { id: { in: [...new Set(commandBlocks.map((block) => block.runId))] } },
    select: {
      id: true,
      status: true,
      leaseExpiresAt: true,
      leaseFence: true,
      attempts: { select: { id: true, fence: true } },
    },
  });
  const byId = new Map(runs.map((run) => [run.id, run]));
  return messages.map((message) => ({
    ...message,
    blocks: message.blocks.map((block) => {
      if (block.kind !== "command") return block;
      const run = byId.get(block.command.runId);
      const live = commandRecordingIsLive(block.command, run);
      return { kind: "command" as const, command: settleCommandBlock(block.command, live) };
    }),
  }));
}

/** Old tool events have no trustworthy command/output fields; make those gaps visible. */
export async function addHistoricalCommandBlocks(
  db: Db,
  messages: ThreadMessage[],
): Promise<ThreadMessage[]> {
  const runIds = [
    ...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : []))),
  ];
  if (!runIds.length) return messages;
  const events = await db.event.findMany({
    where: {
      runId: { in: runIds },
      type: {
        in: ["agent.tool.called", "agent.tool.completed", "agent.tool.resumed", "command.intent"],
      },
    },
    orderBy: { seq: "asc" },
  });
  const legacy = projectCommandBlocks(events).filter((block) =>
    block.commandId.startsWith("legacy:"),
  );
  const byRun = new Map<string, CommandBlock[]>();
  for (const block of legacy) byRun.set(block.runId, [...(byRun.get(block.runId) ?? []), block]);
  if (!legacy.length) return messages;
  const anchors = await db.message.findMany({
    where: { runId: { in: [...byRun.keys()] } },
    orderBy: { seq: "asc" },
    distinct: ["runId"],
    select: { id: true, runId: true },
  });
  const anchorIds = new Set(anchors.map((message) => message.id));
  return messages.flatMap((message) => {
    const blocks =
      message.runId && anchorIds.has(message.id) ? byRun.get(message.runId) : undefined;
    if (!blocks?.length) return [message];
    return [
      ...blocks.map(
        (command): ThreadMessage => ({
          id: `command:${command.commandId}`,
          threadId: message.threadId,
          botId: message.botId,
          runId: command.runId,
          role: "bot",
          seq: message.seq,
          createdAt: message.createdAt,
          blocks: [{ kind: "command", command }],
        }),
      ),
      message,
    ];
  });
}
