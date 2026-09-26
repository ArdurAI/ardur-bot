import type {
  CommandBlock as FixtureCommandBlock,
  ProductEvent as FixtureProductEvent,
  ThreadMessage,
} from "@ardurbot/contracts";
import { resumedCommandMessageId } from "@ardurbot/core";
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
      run: { findUnique: vi.fn(async () => ({ status: "running", leaseFence: 1 })) },
      attempt: { findUnique: vi.fn(async () => ({ fence: 1 })) },
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
  it("lets a resumed call finish the card row its killed call published", async () => {
    const store = eventStore();
    const killed = { commandId: "card-a", executionId: "call-a", attemptId: "attempt-1" };
    const resumed = { commandId: "card-b", executionId: "call-b", attemptId: "attempt-2" };
    await store.append("command.intent", {
      block: commandBlock({ ...killed, ...open("waiting", "2026-09-23T12:00:00.000Z") }),
    });
    await store.append("command.started", {
      block: commandBlock({ ...killed, ...open("running", "2026-09-23T12:00:01.000Z") }),
    });
    await store.append("agent.tool.resumed", { from: "call-a", to: "call-b" });
    await store.append("command.intent", {
      block: commandBlock({ ...resumed, ...open("waiting", "2026-09-23T12:00:30.000Z") }),
    });
    await store.append("command.started", {
      block: commandBlock({ ...resumed, ...open("running", "2026-09-23T12:00:31.000Z") }),
    });
    const finished = commandBlock({
      ...resumed,
      startedAt: "2026-09-23T12:00:31.000Z",
      durationMs: 2_000,
    });
    await store.append("command.finished", { block: finished });
    expect([...store.rows.keys()]).toEqual([resumedCommandMessageId("run-1", "call-b")]);
    expect([...store.rows.values()][0]).toMatchObject({
      seq: 1,
      blocks: [
        {
          kind: "command",
          command: { ...finished, startedAt: "2026-09-23T12:00:01.000Z", durationMs: 32_000 },
        },
      ],
    });
  });
  it("records a recovering attempt's start for the same card once and keeps the first finish", async () => {
    const store = eventStore();
    const card = { commandId: "card-a", executionId: "call-a" };
    const started = (attemptId: string) => ({
      block: commandBlock({ ...card, attemptId, ...open("running", "2026-09-23T12:00:01.000Z") }),
    });
    await store.append("command.started", started("attempt-1"));
    await store.append("command.started", started("attempt-2"));
    await store.append("command.started", started("attempt-2"));
    const finished = commandBlock({ ...card, attemptId: "attempt-2" });
    await store.append("command.finished", { block: finished });
    await store.append("command.finished", { block: { ...finished, stdout: "late" } });
    expect(store.events.map((event) => event.type)).toEqual([
      "command.started",
      "command.started",
      "command.finished",
    ]);
    expect([...store.rows.values()]).toEqual([
      expect.objectContaining({ blocks: [{ kind: "command", command: finished }] }),
    ]);
  });
  it("keeps a lease-lost attempt's late finish as evidence, never letting it override the recovering attempt's card", async () => {
    const store = eventStore({ leaseFence: 2, attemptFences: { "attempt-1": 1, "attempt-2": 2 } });
    const card = { commandId: "card-a", executionId: "call-a" };
    await store.append("command.started", {
      block: commandBlock({
        ...card,
        attemptId: "attempt-1",
        ...open("running", "2026-09-23T12:00:01.000Z"),
      }),
    });
    // Attempt 2 reclaims the run's lease and resumes the same command id.
    await store.append("command.started", {
      block: commandBlock({
        ...card,
        attemptId: "attempt-2",
        ...open("running", "2026-09-23T12:00:01.000Z"),
      }),
    });
    // Attempt 1 wakes past its lost lease and records its own, now stale, finish.
    const staleFinish = commandBlock({ ...card, attemptId: "attempt-1", outcome: "cancelled" });
    await store.append("command.finished", { block: staleFinish });
    // Stored as evidence...
    expect(store.events.map((event) => event.type)).toEqual([
      "command.started",
      "command.started",
      "command.finished",
    ]);
    // ...but never applied to the card the recovering attempt owns.
    expect([...store.rows.values()]).toEqual([
      expect.objectContaining({
        blocks: [
          {
            kind: "command",
            command: expect.objectContaining({ attemptId: "attempt-2", outcome: "running" }),
          },
        ],
      }),
    ]);
    // The recovering attempt's own finish always wins on the card people see.
    const realFinish = commandBlock({
      ...card,
      attemptId: "attempt-2",
      outcome: "completed",
      stdout: "ok",
    });
    await store.append("command.finished", { block: realFinish });
    expect([...store.rows.values()]).toEqual([
      expect.objectContaining({
        blocks: [
          {
            kind: "command",
            command: expect.objectContaining({
              attemptId: "attempt-2",
              outcome: "completed",
              stdout: "ok",
            }),
          },
        ],
      }),
    ]);
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

function open(outcome: "waiting" | "running", startedAt: string): Partial<FixtureCommandBlock> {
  return { outcome, startedAt, durationMs: null, exitCode: null, stdout: null, stderr: null };
}

/** Enough of a transaction to append events and materialize their command rows. */
function eventStore(options: { leaseFence?: number; attemptFences?: Record<string, number> } = {}) {
  const leaseFence = options.leaseFence ?? 1;
  const attemptFences = options.attemptFences ?? {};
  const events: { type: string; payload: unknown; seq: number }[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  type PathFilter = { payload: { path: string[]; equals: unknown } };
  const at = (value: unknown, path: string[]) =>
    path.reduce<unknown>((item, key) => (item as Record<string, unknown> | null)?.[key], value);
  const matches = (
    event: { type: string; payload: unknown },
    where: { type: string; AND?: PathFilter[]; payload?: PathFilter["payload"] },
  ) =>
    event.type === where.type &&
    [...(where.AND ?? []), ...(where.payload ? [{ payload: where.payload }] : [])].every(
      (filter) => at(event.payload, filter.payload.path) === filter.payload.equals,
    );
  let messageSeq = 0;
  const tx = {
    thread: {
      update: vi.fn(async () => ({
        nextEventSeq: events.length + 1,
        nextMessageSeq: ++messageSeq,
      })),
    },
    run: { findUnique: vi.fn(async () => ({ status: "running", leaseFence })) },
    attempt: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        fence: attemptFences[where.id] ?? leaseFence,
      })),
    },
    event: {
      findFirst: vi.fn(
        async ({ where }: { where: Parameters<typeof matches>[1] }) =>
          [...events].reverse().find((event) => matches(event, where)) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: { type: string; payload: unknown } }) => {
        const event = { ...data, id: `event-${events.length}`, seq: events.length };
        events.push(event);
        return event;
      }),
    },
    message: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rows.set(data.id as string, data);
        return data;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = { ...rows.get(where.id)!, ...data };
          rows.delete(where.id);
          rows.set(row.id as string, row);
          return row;
        },
      ),
    },
  } as unknown as Prisma.TransactionClient;
  return {
    events,
    rows,
    append: (type: FixtureProductEvent["type"], payload: Record<string, unknown>) =>
      appendEventInTransaction(tx, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        type,
        payload,
      }),
  };
}

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
