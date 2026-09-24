import type { CommandBlock, ThreadMessage } from "@ardurbot/contracts";
import { CommandEventPayloadSchema } from "@ardurbot/contracts";
import {
  commandRecordingIsLive,
  isCommandEvent,
  projectCommandBlocks,
  settleCommandBlock,
} from "@ardurbot/core";
import type { Prisma, PrismaClient } from "./client.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** Materialized thread row; ordered command events remain the source of truth. */
export async function materializeCommandEvent(
  tx: Prisma.TransactionClient,
  event: {
    type: string;
    payload: unknown;
    threadId: string;
    botId: string;
    runId: string | null;
  },
) {
  if (!isCommandEvent(event.type)) return;
  const { block } = CommandEventPayloadSchema.parse(event.payload);
  const id = `command:${block.commandId}`;
  const blocks = [{ kind: "command", command: block }] as Prisma.InputJsonValue;
  const existing = await tx.message.findUnique({ where: { id }, select: { id: true } });
  if (existing) {
    await tx.message.update({ where: { id }, data: { blocks } });
  } else {
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
        blocks,
      },
    });
  }
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
      type: { in: ["agent.tool.called", "agent.tool.completed", "command.intent"] },
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
