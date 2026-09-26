import type {
  CommandBlock as FixtureCommandBlock,
  ProductEvent as FixtureProductEvent,
  ThreadMessage,
} from "@ardurbot/contracts";
import type { CommandMessagesState } from "@ardurbot/core";
import {
  projectCommandBlocks,
  reduceCommandMessages,
  resumedCommandMessageId,
} from "@ardurbot/core";
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
        findMany: vi.fn(async () => []),
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
    await store.append("agent.tool.resumed", {
      from: "call-a",
      to: "call-b",
      fromCommandId: "card-a",
      toCommandId: "card-b",
    });
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
    expect([...store.rows.keys()]).toEqual([resumedCommandMessageId("card-b")]);
    expect([...store.rows.values()][0]).toMatchObject({
      seq: 1,
      blocks: [
        {
          kind: "command",
          command: {
            ...finished,
            startedAt: "2026-09-23T12:00:01.000Z",
            durationMs: 32_000,
            resumedFrom: ["card-a"],
          },
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
  it("keeps the highest fence's block when a lease-lost attempt finishes late", async () => {
    const store = eventStore();
    const card = { commandId: "card-a", executionId: "call-a" };
    const by = (attemptId: string, fence: number, overrides: Partial<FixtureCommandBlock>) =>
      commandBlock({ ...card, attemptId, fence, ...overrides });
    const startedAt = "2026-09-23T12:00:01.000Z";
    await store.append("command.intent", { block: by("attempt-1", 1, open("waiting", startedAt)) });
    await store.append("command.started", {
      block: by("attempt-1", 1, open("running", startedAt)),
    });
    // Attempt 2 reclaims the run's lease and resumes the same command id.
    await store.append("command.started", {
      block: by("attempt-2", 2, open("running", startedAt)),
    });
    const finished = by("attempt-2", 2, { startedAt, stdout: "ok" });
    await store.append("command.finished", { block: finished });
    // Attempt 1 wakes past its lost lease and records its own, now stale, finish.
    await store.append("command.finished", {
      block: by("attempt-1", 1, { startedAt, outcome: "cancelled" }),
    });
    // Stored as evidence, never applied to the card the recovering attempt owns.
    expect(store.events.map((event) => event.type)).toEqual([
      "command.intent",
      "command.started",
      "command.started",
      "command.finished",
      "command.finished",
    ]);
    expect([...store.rows.values()]).toEqual([
      expect.objectContaining({ blocks: [{ kind: "command", command: finished }] }),
    ]);
  });
  it("keeps a lease-lost attempt's late finish off a card a resumed call took over", async () => {
    const store = eventStore();
    const killed = { commandId: "card-a", executionId: "call-a", attemptId: "attempt-1", fence: 1 };
    const resumed = {
      commandId: "card-b",
      executionId: "call-b",
      attemptId: "attempt-2",
      fence: 2,
    };
    await store.append("command.intent", {
      block: commandBlock({ ...killed, ...open("waiting", "2026-09-23T12:00:00.000Z") }),
    });
    await store.append("command.started", {
      block: commandBlock({ ...killed, ...open("running", "2026-09-23T12:00:01.000Z") }),
    });
    await store.append("agent.tool.resumed", {
      from: "call-a",
      to: "call-b",
      fromCommandId: "card-a",
      toCommandId: "card-b",
    });
    await store.append("command.intent", {
      block: commandBlock({ ...resumed, ...open("waiting", "2026-09-23T12:00:30.000Z") }),
    });
    await store.append("command.finished", {
      block: commandBlock({ ...killed, outcome: "cancelled" }),
    });
    expect([...store.rows.keys()]).toEqual([resumedCommandMessageId("card-b")]);
    expect([...store.rows.values()][0]).toMatchObject({
      blocks: [{ kind: "command", command: { commandId: "card-b", outcome: "waiting" } }],
    });
  });
  it("gives a later call that reuses a resumed call's id its own card row", async () => {
    const build = { command: "pnpm build", executionId: "run-1:shell:0" };
    const resumed = { commandId: "card-b", executionId: "run-1:shell:1", attemptId: "attempt-2" };
    const cards = await storedCards([
      ["command.intent", card("card-a", 1, { ...build, ...open("waiting", clock(0)) })],
      ["command.started", card("card-a", 1, { ...build, ...open("running", clock(1)) })],
      ["agent.tool.resumed", link(build.executionId, resumed.executionId, "card-a", "card-b")],
      [
        "command.intent",
        card("card-b", 2, { ...resumed, command: "pnpm build", ...open("waiting", clock(30)) }),
      ],
      [
        "command.finished",
        card("card-b", 2, {
          ...resumed,
          command: "pnpm build",
          startedAt: clock(31),
          stdout: "built",
        }),
      ],
      // After a pause the runtime numbers its calls from zero again: `pnpm test` reuses the id.
      [
        "command.intent",
        card("card-c", 3, {
          executionId: resumed.executionId,
          command: "pnpm test",
          ...open("waiting", clock(300)),
        }),
      ],
      [
        "command.finished",
        card("card-c", 3, {
          executionId: resumed.executionId,
          command: "pnpm test",
          startedAt: clock(300),
          stdout: "tested",
        }),
      ],
    ]);
    expect(cards).toEqual([
      [resumedCommandMessageId("card-b"), "pnpm build", "completed", "built", clock(1)],
      ["command:card-c", "pnpm test", "completed", "tested", clock(300)],
    ]);
  });
  it("renames only the card row the link names, never another card its id once had", async () => {
    const reused = "run-1:shell:0";
    const cards = await storedCards([
      [
        "command.intent",
        card("card-x", 1, { executionId: reused, command: "ls", ...open("waiting", clock(0)) }),
      ],
      [
        "command.finished",
        card("card-x", 1, { executionId: reused, command: "ls", stdout: "src" }),
      ],
      [
        "command.intent",
        card("card-y", 2, { executionId: reused, command: "pwd", ...open("waiting", clock(60)) }),
      ],
      [
        "command.started",
        card("card-y", 2, { executionId: reused, command: "pwd", ...open("running", clock(61)) }),
      ],
      ["agent.tool.resumed", link(reused, "run-1:shell:1", "card-y", "card-z")],
      [
        "command.intent",
        card("card-z", 3, {
          executionId: "run-1:shell:1",
          command: "pwd",
          ...open("waiting", clock(120)),
        }),
      ],
      [
        "command.finished",
        card("card-z", 3, {
          executionId: "run-1:shell:1",
          command: "pwd",
          startedAt: clock(121),
          stdout: "/workspace",
        }),
      ],
    ]);
    expect(cards).toEqual([
      ["command:card-x", "ls", "completed", "src", clock(0)],
      [resumedCommandMessageId("card-z"), "pwd", "completed", "/workspace", clock(61)],
    ]);
  });
  it("keeps a resumed-away call's late finish off every reader, before and after reload", async () => {
    const cards = await storedCards([
      [
        "command.intent",
        card("card-a", 1, { executionId: "call-a", ...open("waiting", clock(0)) }),
      ],
      [
        "command.started",
        card("card-a", 1, { executionId: "call-a", ...open("running", clock(1)) }),
      ],
      ["agent.tool.resumed", link("call-a", "call-b", "card-a", "card-b")],
      [
        "command.intent",
        card("card-b", 2, { executionId: "call-b", ...open("waiting", clock(30)) }),
      ],
      [
        "command.started",
        card("card-b", 2, { executionId: "call-b", ...open("running", clock(31)) }),
      ],
      [
        "command.finished",
        card("card-b", 2, { executionId: "call-b", startedAt: clock(31), stdout: "ok" }),
      ],
      // The attempt that lost its lease wakes and records its own, now stale, finish.
      ["command.finished", card("card-a", 1, { executionId: "call-a", outcome: "cancelled" })],
    ]);
    expect(cards).toEqual([
      [resumedCommandMessageId("card-b"), "pnpm test", "completed", "ok", clock(1)],
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

const clock = (seconds: number) => new Date(Date.UTC(2026, 8, 23, 12, 0, seconds)).toISOString();

function card(commandId: string, fence: number, overrides: Partial<FixtureCommandBlock>) {
  return { block: commandBlock({ commandId, attemptId: `attempt-${fence}`, fence, ...overrides }) };
}

function link(from: string, to: string, fromCommandId: string, toCommandId: string) {
  return { from, to, fromCommandId, toCommandId };
}

/**
 * Appends `events` through the real append path. The stored rows, the projection behind list,
 * open, export and rerun, and the live thread, resumed from a reload after any event, must show
 * the same cards, one message per card. Returns the stored cards.
 */
async function storedCards(events: [FixtureProductEvent["type"], Record<string, unknown>][]) {
  const store = eventStore();
  const reloads: ThreadMessage[][] = [store.messages()];
  for (const [type, payload] of events) {
    await store.append(type, payload);
    reloads.push(store.messages());
  }
  const stored = reloads.at(-1)!;
  const shown = (messages: ThreadMessage[]) =>
    messages.map((message) => [message.id, message.blocks]);
  const productEvents = store.events.map((event) => ({
    ...event,
    id: `event-${event.seq}`,
    threadId: "thread-1",
    runId: "run-1",
    createdAt: clock(0),
  }));
  reloads.forEach((reloaded, cursor) => {
    const live = productEvents
      .slice(cursor)
      .reduce((state, event) => reduceCommandMessages(state, event), {
        messages: reloaded,
        links: [],
      } as CommandMessagesState<ThreadMessage>).messages as ThreadMessage[];
    expect(shown(live), `live after a reload at event ${cursor}`).toEqual(shown(stored));
  });
  const ids = stored.map((message) => message.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(stored.map((message) => message.blocks[0])).toEqual(
    projectCommandBlocks(productEvents, new Set(["run-1"])).map((command) => ({
      kind: "command",
      command,
    })),
  );
  return stored.map((message) => {
    const [block] = message.blocks;
    const command = block?.kind === "command" ? block.command : undefined;
    return [message.id, command?.command, command?.outcome, command?.stdout, command?.startedAt];
  });
}

function open(outcome: "waiting" | "running", startedAt: string): Partial<FixtureCommandBlock> {
  return { outcome, startedAt, durationMs: null, exitCode: null, stdout: null, stderr: null };
}

/** Enough of a transaction to append events and materialize their command rows. */
function eventStore() {
  const events: { id: string; type: string; payload: unknown; seq: number }[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  type PathFilter = { payload: { path: string[]; equals: unknown } };
  const at = (value: unknown, path: string[]) =>
    path.reduce<unknown>((item, key) => (item as Record<string, unknown> | null)?.[key], value);
  const holds = (event: { payload: unknown }, filter: PathFilter) =>
    at(event.payload, filter.payload.path) === filter.payload.equals;
  const matches = (
    event: { id: string; type: string; payload: unknown },
    where: {
      type: string;
      id?: { not: string };
      AND?: PathFilter[];
      OR?: PathFilter[];
      payload?: PathFilter["payload"];
    },
  ) =>
    event.type === where.type &&
    event.id !== where.id?.not &&
    [...(where.AND ?? []), ...(where.payload ? [{ payload: where.payload }] : [])].every((filter) =>
      holds(event, filter),
    ) &&
    (!where.OR || where.OR.some((filter) => holds(event, filter)));
  let messageSeq = 0;
  const tx = {
    thread: {
      update: vi.fn(async () => ({
        nextEventSeq: events.length + 1,
        nextMessageSeq: ++messageSeq,
      })),
    },
    run: { findUnique: vi.fn(async () => ({ status: "running" })) },
    event: {
      findFirst: vi.fn(
        async ({ where }: { where: Parameters<typeof matches>[1] }) =>
          [...events].reverse().find((event) => matches(event, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Parameters<typeof matches>[1] }) =>
        events.filter((event) => matches(event, where)),
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
    /** The stored rows as a thread snapshot lists them, in message order. */
    messages: () =>
      [...rows.values()]
        .sort((a, b) => (a.seq as number) - (b.seq as number))
        .map(
          (row): ThreadMessage => ({
            id: row.id as string,
            threadId: "thread-1",
            botId: "bot-1",
            runId: "run-1",
            role: "bot",
            seq: row.seq as number,
            createdAt: clock(0),
            blocks: row.blocks as ThreadMessage["blocks"],
          }),
        ),
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
