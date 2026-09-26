import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import { runContinueJob } from "@ardurbot/adapter-kit";
import { validateCommandReplay } from "@ardurbot/adapters";
import type { Actor, CommandBlock } from "@ardurbot/contracts";
import {
  commandRecordingIsLive,
  exportCommandLog,
  projectCommandBlocks,
  searchCommandBlocks,
  settleCommandBlock,
} from "@ardurbot/core";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";

type Deps = { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher };

export function createCommandRoutes(deps: Deps) {
  async function ownedRun(actor: Actor, runId: string) {
    const run = await deps.prisma.run.findFirst({
      where: {
        id: runId,
        userId: actor.userId,
        spaceId: actor.spaceId,
        bot: { userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
      },
      include: {
        bot: { include: { computer: true } },
        attempts: { select: { id: true, fence: true } },
      },
    });
    if (!run) throw new IsolationError();
    return run;
  }

  async function authorizeComputers(actor: Actor, blocks: CommandBlock[]) {
    for (const computerId of new Set(
      blocks.flatMap((block) => (block.computerId ? [block.computerId] : [])),
    )) {
      const computer = await deps.prisma.computer.findFirst({
        where: {
          id: computerId,
          spaceId: actor.spaceId,
          OR: [
            { scope: "team", scopeKey: `team:${actor.spaceId}` },
            { scope: "dedicated", userId: actor.userId },
          ],
        },
      });
      if (!computer) throw new IsolationError();
    }
  }

  async function load(actor: Actor, runId: string) {
    const run = await ownedRun(actor, runId);
    const events = await deps.prisma.event.findMany({
      where: {
        runId,
        spaceId: actor.spaceId,
        type: {
          in: [
            "command.intent",
            "command.started",
            "command.finished",
            "agent.tool.called",
            "agent.tool.completed",
            "agent.tool.resumed",
            "run.completed",
            "run.failed",
            "run.cancelled",
          ],
        },
      },
      orderBy: { seq: "asc" },
    });
    let blocks = projectCommandBlocks(events, new Set([runId])).map((block) =>
      settleCommandBlock(block, commandRecordingIsLive(block, run)),
    );
    await authorizeComputers(actor, blocks);
    blocks = blocks.map((block) => {
      const original = events.find(
        (event) =>
          event.type === "command.intent" &&
          (event.payload as { block?: { commandId?: string } }).block?.commandId ===
            block.commandId,
      );
      const replay = run.bot.computer
        ? validateCommandReplay(original?.payload, run.bot.computer)
        : { reason: "The computer is no longer available." };
      return {
        ...block,
        rerunDisabledReason: run.bot.computerSwitching
          ? "The computer is changing; try again when it is ready."
          : "reason" in replay
            ? (replay.reason ?? block.rerunDisabledReason)
            : block.rerunDisabledReason,
      };
    });
    return { run, blocks, events };
  }

  async function audit(
    actor: Actor,
    run: Awaited<ReturnType<typeof ownedRun>>,
    blocks: CommandBlock[],
    type: "command.exported" | "command.shared",
  ) {
    await deps.events.append({
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      // Auditing a cancelled run is allowed; its ID is metadata, not a history-write grant.
      type,
      payload: {
        actorUserId: actor.userId,
        spaceId: actor.spaceId,
        runId: run.id,
        commandIds: blocks.map((block) => block.commandId),
        computerIds: [
          ...new Set(blocks.flatMap((block) => (block.computerId ? [block.computerId] : []))),
        ],
        at: new Date().toISOString(),
      },
    });
  }

  return {
    async list(actor: Actor, input: { runId: string; query?: string }) {
      const { blocks } = await load(actor, input.runId);
      return { blocks: input.query ? searchCommandBlocks(blocks, input.query) : blocks };
    },
    async open(actor: Actor, input: { runId: string; commandId: string }) {
      const { blocks } = await load(actor, input.runId);
      const block = blocks.find((candidate) => candidate.commandId === input.commandId);
      if (!block) throw new IsolationError();
      return block;
    },
    async export(actor: Actor, input: { runId: string; commandId?: string }) {
      const { run, blocks } = await load(actor, input.runId);
      const selected = input.commandId
        ? blocks.filter((block) => block.commandId === input.commandId)
        : blocks;
      if (input.commandId && !selected.length) throw new IsolationError();
      await audit(actor, run, selected, "command.exported");
      return { text: exportCommandLog(run.id, selected), filename: `run-${run.id}.log` };
    },
    async share(actor: Actor, input: { runId: string; commandId: string }) {
      const { run, blocks } = await load(actor, input.runId);
      const block = blocks.find((candidate) => candidate.commandId === input.commandId);
      if (!block) throw new IsolationError();
      await audit(actor, run, [block], "command.shared");
      return {
        path: `/commands/${encodeURIComponent(run.id)}/${encodeURIComponent(block.commandId)}?space=${encodeURIComponent(actor.spaceId)}`,
      };
    },
    async rerun(actor: Actor, input: { runId: string; commandId: string }) {
      const { run, blocks, events } = await load(actor, input.runId);
      const block = blocks.find((candidate) => candidate.commandId === input.commandId);
      if (!block) throw new IsolationError();
      if (block.rerunDisabledReason || !run.bot.computer || run.bot.computerSwitching) {
        throw new ORPCError("CONFLICT", {
          message:
            block.rerunDisabledReason ?? "The computer is changing; try again when it is ready.",
        });
      }
      const original = events.find(
        (event) =>
          event.type === "command.intent" &&
          (event.payload as { block?: { commandId?: string } }).block?.commandId ===
            block.commandId,
      );
      const replay = validateCommandReplay(original?.payload, run.bot.computer);
      if ("reason" in replay) throw new ORPCError("CONFLICT", { message: replay.reason });
      const next = await deps.prisma.$transaction(async (tx) => {
        const task = await tx.task.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: run.botId,
            threadId: run.threadId,
            prompt: "Rerun the recorded command.",
            status: "pending",
          },
        });
        return tx.run.create({
          data: {
            taskId: task.id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: run.botId,
            threadId: run.threadId,
            status: "queued",
            // Retain restrictions such as mandatory approval on webhook-originated work.
            trigger: run.trigger,
            commandReplayId: block.commandId,
            clientNonce: `command-rerun:${randomUUID()}`,
          },
        });
      });
      await deps.jobs.enqueue(runContinueJob(next.id));
      return { runId: next.id };
    },
  };
}
