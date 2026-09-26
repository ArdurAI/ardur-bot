import type { CommandBlock } from "@ardurbot/contracts";
import { resumedCommandMessageId } from "@ardurbot/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { finishedCommandIds } from "./command-blocks.js";
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

    // The resumed call links to the killed call and names both cards.
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "agent.tool.resumed",
      payload: { from: executionA, to: executionB, fromCommandId: commandA, toCommandId: commandB },
    });
    const resumedRowId = resumedCommandMessageId(commandB);
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
      resumedFrom: [commandA],
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

  it("keeps a lease-lost attempt's late finish as evidence, never letting it override the recovering attempt's card (same id)", async () => {
    const attempt1 = await prisma.attempt.create({ data: { runId, fence: 10, status: "running" } });
    const attempt2 = await prisma.attempt.create({ data: { runId, fence: 11, status: "running" } });
    await prisma.run.update({ where: { id: runId }, data: { leaseFence: 10 } });
    const sameId = `cb-cmd-same-${suffix}`;
    const executionSame = "cb-exec-same";
    const ownRowId = `command:${sameId}`;
    const byAttempt1 = block({
      commandId: sameId,
      executionId: executionSame,
      attemptId: attempt1.id,
      fence: attempt1.fence,
      outcome: "running",
      startedAt: startedAtEarlier,
    });
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.intent",
      payload: { block: { ...byAttempt1, outcome: "waiting" } },
    });
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.started",
      payload: { block: byAttempt1 },
    });

    // Attempt 2 reclaims the run's lease and resumes the same command id.
    await prisma.run.update({ where: { id: runId }, data: { leaseFence: 11 } });
    const byAttempt2 = { ...byAttempt1, attemptId: attempt2.id, fence: attempt2.fence };
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.started",
      payload: { block: byAttempt2 },
    });

    // Attempt 1 wakes past its lost lease and records its own, now stale, finish.
    const finishCountBefore = await prisma.event.count({
      where: { runId, type: "command.finished" },
    });
    const staleFinish = { ...byAttempt1, outcome: "cancelled" as const };
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.finished",
      payload: { block: staleFinish },
    });
    // Stored as evidence...
    expect(await prisma.event.count({ where: { runId, type: "command.finished" } })).toBe(
      finishCountBefore + 1,
    );
    // ...but never applied to the card the recovering attempt owns.
    const afterStaleFinish = await prisma.message.findUniqueOrThrow({ where: { id: ownRowId } });
    expect(
      (afterStaleFinish.blocks as unknown as { command: CommandBlock }[])[0]!.command,
    ).toMatchObject({ attemptId: attempt2.id, outcome: "running" });

    // The recovering attempt's own finish always wins on the card people see.
    const realFinish = { ...byAttempt2, outcome: "completed" as const, exitCode: 0, stdout: "ok" };
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.finished",
      payload: { block: realFinish },
    });
    const finalRow = await prisma.message.findUniqueOrThrow({ where: { id: ownRowId } });
    expect((finalRow.blocks as unknown as { command: CommandBlock }[])[0]!.command).toMatchObject({
      attemptId: attempt2.id,
      outcome: "completed",
      stdout: "ok",
    });
  });

  /** Appends one command event for card `commandId` recorded by the attempt with `fence`. */
  async function record(
    type: "command.intent" | "command.started" | "command.finished",
    commandId: string,
    fence: number,
    overrides: Partial<CommandBlock> & Pick<CommandBlock, "executionId" | "command">,
  ) {
    const outcome =
      type === "command.intent" ? "waiting" : type === "command.started" ? "running" : "completed";
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type,
      payload: {
        block: block({ commandId, attemptId: `attempt-${fence}`, fence, outcome, ...overrides }),
      },
    });
  }

  async function shownCard(id: string) {
    const row = await prisma.message.findUniqueOrThrow({ where: { id } });
    return (row.blocks as unknown as { command: CommandBlock }[])[0]!.command;
  }

  it("gives a later call that reuses a resumed call's id its own card row", async () => {
    const [killed, resumed, reused] = ["build-a", "build-b", "test-c"].map(
      (name) => `cb-cmd-${name}-${suffix}`,
    ) as [string, string, string];
    const build = { command: "pnpm build" };
    await record("command.intent", killed, 30, { ...build, executionId: "cb-shell:0" });
    await record("command.started", killed, 30, { ...build, executionId: "cb-shell:0" });
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "agent.tool.resumed",
      payload: {
        from: "cb-shell:0",
        to: "cb-shell:1",
        fromCommandId: killed,
        toCommandId: resumed,
      },
    });
    await record("command.intent", resumed, 31, { ...build, executionId: "cb-shell:1" });
    await record("command.finished", resumed, 31, {
      ...build,
      executionId: "cb-shell:1",
      startedAt: startedAtLater,
      stdout: "built",
    });
    // After a pause the runtime numbers its calls from zero again: `pnpm test` reuses the id.
    const test = { command: "pnpm test", executionId: "cb-shell:1", startedAt: startedAtLater };
    await record("command.intent", reused, 32, test);
    await record("command.finished", reused, 32, { ...test, stdout: "tested" });
    await expect(shownCard(resumedCommandMessageId(resumed))).resolves.toMatchObject({
      commandId: resumed,
      command: "pnpm build",
      stdout: "built",
      startedAt: startedAtEarlier,
    });
    await expect(shownCard(`command:${reused}`)).resolves.toMatchObject({
      command: "pnpm test",
      stdout: "tested",
      startedAt: startedAtLater,
    });
  });

  it("renames only the card row the link names, never another card its id once had", async () => {
    const [listed, killed, resumed] = ["ls-x", "pwd-y", "pwd-z"].map(
      (name) => `cb-cmd-${name}-${suffix}`,
    ) as [string, string, string];
    await record("command.intent", listed, 40, { command: "ls", executionId: "cb-sweep:0" });
    await record("command.finished", listed, 40, {
      command: "ls",
      executionId: "cb-sweep:0",
      stdout: "src",
    });
    await record("command.intent", killed, 41, { command: "pwd", executionId: "cb-sweep:0" });
    await record("command.started", killed, 41, { command: "pwd", executionId: "cb-sweep:0" });
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "agent.tool.resumed",
      payload: {
        from: "cb-sweep:0",
        to: "cb-sweep:1",
        fromCommandId: killed,
        toCommandId: resumed,
      },
    });
    await record("command.intent", resumed, 42, { command: "pwd", executionId: "cb-sweep:1" });
    await expect(shownCard(`command:${listed}`)).resolves.toMatchObject({
      command: "ls",
      outcome: "completed",
      stdout: "src",
    });
    expect(await prisma.message.findUnique({ where: { id: `command:${killed}` } })).toBeNull();
    await expect(shownCard(resumedCommandMessageId(resumed))).resolves.toMatchObject({
      commandId: resumed,
      command: "pwd",
      resumedFrom: [killed],
    });
  });

  it("skips a lease-lost attempt's late finish once its card has been resumed under a new id", async () => {
    const attempt1 = await prisma.attempt.create({ data: { runId, fence: 20, status: "running" } });
    await prisma.attempt.create({ data: { runId, fence: 21, status: "running" } });
    await prisma.run.update({ where: { id: runId }, data: { leaseFence: 20 } });
    const newIdCommand = `cb-cmd-newid-${suffix}`;
    const executionOld = "cb-exec-newid-old";
    const executionNew = "cb-exec-newid-new";
    const ownRowId = `command:${newIdCommand}`;
    const byAttempt1 = block({
      commandId: newIdCommand,
      executionId: executionOld,
      attemptId: attempt1.id,
      fence: attempt1.fence,
      outcome: "running",
      startedAt: startedAtEarlier,
    });
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.intent",
      payload: { block: { ...byAttempt1, outcome: "waiting" } },
    });
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.started",
      payload: { block: byAttempt1 },
    });
    await expect(
      prisma.message.findUniqueOrThrow({ where: { id: ownRowId } }),
    ).resolves.toMatchObject({ id: ownRowId });

    // Attempt 2 reclaims the lease and resumes under a fresh execution id: the card is renamed.
    await prisma.run.update({ where: { id: runId }, data: { leaseFence: 21 } });
    const resumedCommand = `cb-cmd-newid-resumed-${suffix}`;
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "agent.tool.resumed",
      payload: {
        from: executionOld,
        to: executionNew,
        fromCommandId: newIdCommand,
        toCommandId: resumedCommand,
      },
    });
    const resumedRowId = resumedCommandMessageId(resumedCommand);
    expect(await prisma.message.findUnique({ where: { id: ownRowId } })).toBeNull();
    await expect(
      prisma.message.findUniqueOrThrow({ where: { id: resumedRowId } }),
    ).resolves.toMatchObject({ id: resumedRowId });

    // Attempt 1 wakes past its lost lease and records a finish for its now-superseded card.
    const messageCountBefore = await prisma.message.count({
      where: { threadId, id: { startsWith: "command" } },
    });
    const staleFinish = { ...byAttempt1, outcome: "cancelled" as const };
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId,
      type: "command.finished",
      payload: { block: staleFinish },
    });
    // No second card resurrected for the superseded commandId, and the renamed row is untouched.
    expect(await prisma.message.count({ where: { threadId, id: { startsWith: "command" } } })).toBe(
      messageCountBefore,
    );
    expect(await prisma.message.findUnique({ where: { id: ownRowId } })).toBeNull();
    await expect(
      prisma.message.findUniqueOrThrow({ where: { id: resumedRowId } }),
    ).resolves.toMatchObject({ id: resumedRowId });
  });

  it("names every commandId a command.finished event recorded for the run, scoped to that run", async () => {
    const finishedHere = `cb-cmd-finished-${suffix}`;
    const stillOpen = `cb-cmd-open-${suffix}`;
    const finishedElsewhere = `cb-cmd-elsewhere-${suffix}`;
    await record("command.intent", finishedHere, 50, {
      command: "pnpm test",
      executionId: "cb-finished-ids:0",
    });
    await record("command.finished", finishedHere, 50, {
      command: "pnpm test",
      executionId: "cb-finished-ids:0",
      stdout: "ok",
    });
    await record("command.intent", stillOpen, 51, {
      command: "pnpm build",
      executionId: "cb-finished-ids:1",
    });
    const otherTask = await prisma.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "Run another command", status: "running" },
    });
    const otherRun = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: otherTask.id,
        userId,
        status: "running",
        trigger: "user",
      },
    });
    await appendEvent(prisma, {
      spaceId,
      threadId,
      botId,
      runId: otherRun.id,
      type: "command.finished",
      payload: {
        block: block({
          runId: otherRun.id,
          commandId: finishedElsewhere,
          executionId: "cb-finished-ids:elsewhere",
          attemptId: "attempt-elsewhere",
          outcome: "completed",
        }),
      },
    });

    // Other cases in this shared run already finished their own commandIds; this only checks
    // that the real JSON-path query finds this one, and stays scoped to its own run.
    const hereIds = await finishedCommandIds(prisma, runId);
    expect(hereIds.has(finishedHere)).toBe(true);
    expect(hereIds.has(stillOpen)).toBe(false);
    expect(hereIds.has(finishedElsewhere)).toBe(false);
    expect(await finishedCommandIds(prisma, otherRun.id)).toEqual(new Set([finishedElsewhere]));
  });
});
