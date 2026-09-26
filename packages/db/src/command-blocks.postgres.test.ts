import type { CommandBlock } from "@ardurbot/contracts";
import { resumedCommandMessageId } from "@ardurbot/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { appendEvent } from "./events.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("resumed command materialization (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `cb-org-${suffix}`;
  const spaceId = `cb-space-${suffix}`;
  const userId = `cb-user-${suffix}`;
  const executionA = "cb-exec-a";
  const executionB = "cb-exec-b";
  const commandA = `cb-cmd-a-${suffix}`;
  const commandB = `cb-cmd-b-${suffix}`;
  const startedAtEarlier = "2026-01-01T00:00:00.000Z";
  const startedAtLater = "2026-01-01T00:00:05.000Z";
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;
  let threadId: string;
  let runId: string;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Command blocks fixture",
        slug: organizationId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "Command blocks fixture" } },
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Command blocks fixture", color: "ink" },
    });
    botId = bot.id;
    const thread = await prisma.thread.create({
      data: { spaceId, userId, botId },
    });
    threadId = thread.id;
    const task = await prisma.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "Run a command", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: "running",
        trigger: "user",
      },
    });
    runId = run.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await close();
  });

  function block(
    overrides: Partial<CommandBlock> &
      Pick<CommandBlock, "commandId" | "executionId" | "attemptId" | "outcome">,
  ): CommandBlock {
    return {
      runId,
      command: "echo hi",
      cwd: "/workspace",
      computerId: "computer-1",
      computer: "desktop:computer-1",
      startedAt: startedAtEarlier,
      durationMs: null,
      exitCode: null,
      stdout: null,
      stderr: null,
      error: null,
      redacted: false,
      truncated: false,
      replayOf: null,
      rerunDisabledReason: null,
      ...overrides,
    };
  }

  it("resumes a killed card into one materialized row under a renamed primary key, and dedupes redelivery", async () => {
    // Attempt 1: the killed call publishes its card.
    const blockA = block({
      commandId: commandA,
      executionId: executionA,
      attemptId: "attempt-1",
      outcome: "waiting",
      startedAt: startedAtEarlier,
    });
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.intent",
      payload: { block: blockA },
    });
    const ownRowId = `command:${commandA}`;
    await expect(
      prisma.message.findUniqueOrThrow({ where: { id: ownRowId } }),
    ).resolves.toMatchObject({ id: ownRowId });

    // The resumed call links to the killed call's execution id.
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "agent.tool.resumed",
      payload: { from: executionA, to: executionB },
    });
    const resumedRowId = resumedCommandMessageId(runId, executionB);
    // The renamed primary key: the killed call's row no longer exists at its own id.
    expect(await prisma.message.findUnique({ where: { id: ownRowId } })).toBeNull();
    await expect(
      prisma.message.findUniqueOrThrow({ where: { id: resumedRowId } }),
    ).resolves.toMatchObject({ id: resumedRowId });

    // Attempt 2: a fresh commandId for the resumed execution id, merged into the renamed row.
    const blockBIntent = block({
      commandId: commandB,
      executionId: executionB,
      attemptId: "attempt-2",
      outcome: "waiting",
      startedAt: startedAtLater,
    });
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.intent",
      payload: { block: blockBIntent },
    });
    const blockBStarted = { ...blockBIntent, outcome: "running" as const };
    const started = await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.started",
      payload: { block: blockBStarted },
    });
    const blockBFinished = {
      ...blockBIntent,
      outcome: "completed" as const,
      exitCode: 0,
      stdout: "ok",
      durationMs: 250,
    };
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.finished",
      payload: { block: blockBFinished },
    });

    // One materialized row for the entire chain, holding the latest recorded card, timed from
    // the earliest card's start.
    expect(await prisma.message.count({ where: { threadId, id: { startsWith: "command" } } })).toBe(
      1,
    );
    const finalRow = await prisma.message.findUniqueOrThrow({ where: { id: resumedRowId } });
    const finalBlocks = finalRow.blocks as unknown as { kind: string; command: CommandBlock }[];
    expect(finalBlocks[0]!.command).toMatchObject({
      commandId: commandB,
      outcome: "completed",
      stdout: "ok",
      startedAt: startedAtEarlier,
      durationMs:
        Date.parse(startedAtLater) - Date.parse(startedAtEarlier) + blockBFinished.durationMs,
    });

    // The dedupe filter: redelivering the same attempt's start writes no second event or row.
    const beforeCount = await prisma.event.count({ where: { runId, type: "command.started" } });
    const redelivered = await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.started",
      payload: { block: blockBStarted },
    });
    expect(redelivered.id).toBe(started.id);
    expect(await prisma.event.count({ where: { runId, type: "command.started" } })).toBe(
      beforeCount,
    );
  });
});
