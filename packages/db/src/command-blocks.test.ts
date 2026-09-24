import type {
  CommandBlock as FixtureCommandBlock,
  ProductEvent as FixtureProductEvent,
  ThreadMessage,
} from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { addHistoricalCommandBlocks, hydrateCommandMessages } from "./command-blocks.js";
import { appendEventInTransaction } from "./events.js";

describe("command event persistence", () => {
  it("deduplicates delivery and materializes the same block row transactionally", async () => {
    const events: Record<string, unknown>[] = [];
    const messages: Record<string, unknown>[] = [];
    const tx = {
      thread: { update: vi.fn(async () => ({ nextEventSeq: 2, nextMessageSeq: 2 })) },
      run: { findUnique: vi.fn(async () => ({ status: "running" })) },
      event: {
        findFirst: vi.fn(
          async ({ where }: { where: { type: string } }) =>
            events.find((event) => event.type === where.type) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const event = { ...data, id: "event-1", createdAt: new Date() };
          events.push(event);
          return event;
        }),
      },
      message: {
        findUnique: vi.fn(async () => messages[0] ?? null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          messages.push(data);
          return data;
        }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
          Object.assign(messages[0]!, data),
        ),
      },
    };
    const event = commandEvent("command.intent", { outcome: "waiting" });
    await appendEventInTransaction(tx as unknown as Prisma.TransactionClient, event);
    await appendEventInTransaction(tx as unknown as Prisma.TransactionClient, event);
    await appendEventInTransaction(tx as unknown as Prisma.TransactionClient, commandEvent());
    expect(events).toHaveLength(2);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks).toEqual([{ kind: "command", command: commandBlock() }]);
  });
  it("projects expired or superseded attempts as unknown on reload", async () => {
    const message: ThreadMessage = {
      id: "command:command-1",
      threadId: "thread-1",
      seq: 1,
      role: "bot",
      runId: "run-1",
      createdAt: "2026-09-23T12:00:00.000Z",
      blocks: [
        {
          kind: "command",
          command: commandBlock({ outcome: "running", durationMs: null, exitCode: null }),
        },
      ],
    };
    const run = {
      id: "run-1",
      status: "running",
      leaseExpiresAt: new Date(0),
      leaseFence: 1,
      attempts: [{ id: "attempt-1", fence: 1 }],
    };
    const db = { run: { findMany: async () => [run] } } as unknown as PrismaClient;
    expect((await hydrateCommandMessages(db, [message]))[0]?.blocks[0]).toMatchObject({
      command: { outcome: "unknown" },
    });
    run.leaseExpiresAt = new Date(Date.now() + 60000);
    expect((await hydrateCommandMessages(db, [message]))[0]?.blocks[0]).toMatchObject({
      command: { outcome: "running" },
    });
    run.leaseFence = 2;
    expect((await hydrateCommandMessages(db, [message]))[0]?.blocks[0]).toMatchObject({
      command: { outcome: "unknown" },
    });
  });
  it("adds historical command gaps without exposing old tool payloads", async () => {
    const db = {
      message: { findMany: async () => [{ id: "message-1", runId: "run-1" }] },
      event: {
        findMany: async () => [
          {
            ...commandEvent(),
            type: "agent.tool.called",
            payload: { name: "shell", executionId: "old" },
          },
        ],
      },
    } as unknown as PrismaClient;
    const message: ThreadMessage = {
      id: "message-1",
      threadId: "thread-1",
      runId: "run-1",
      role: "bot",
      seq: 1,
      createdAt: "2026-09-23T12:00:00.000Z",
      blocks: [{ kind: "text", text: "Done" }],
    };
    const result = await addHistoricalCommandBlocks(db, [message]);
    expect(result[1]).toBe(message);
    expect(await addHistoricalCommandBlocks(db, [{ ...message, id: "later-message" }])).toEqual([
      { ...message, id: "later-message" },
    ]);
    expect(result[0]?.blocks[0]).toMatchObject({
      kind: "command",
      command: { command: null, cwd: null, stdout: null, outcome: "unknown" },
    });
  });
});

function commandBlock(overrides: Partial<FixtureCommandBlock> = {}): FixtureCommandBlock {
  return {
    commandId: "command-1",
    runId: "run-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    command: "pnpm test",
    cwd: "/workspace",
    computerId: "computer-1",
    computer: "docker:container-1",
    startedAt: "2026-09-23T12:00:00.000Z",
    durationMs: 12000,
    exitCode: 0,
    outcome: "completed",
    stdout: "Tests passed.\n",
    stderr: "",
    error: null,
    redacted: false,
    truncated: false,
    replayOf: null,
    rerunDisabledReason: null,
    ...overrides,
  };
}

function commandEvent(
  type: FixtureProductEvent["type"] = "command.finished",
  overrides: Partial<FixtureCommandBlock> = {},
): FixtureProductEvent {
  return {
    id: type,
    seq: type === "command.intent" ? 1 : type === "command.started" ? 2 : 3,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    runId: "run-1",
    createdAt: "2026-09-23T12:00:00.000Z",
    type,
    payload: { block: commandBlock(overrides) },
  };
}
