import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import type { CreateThreadMessageInput } from "./messages.js";
import { createThreadMessageInTransaction } from "./messages.js";

function transaction() {
  return {
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
    run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
  };
}

/**
 * In-memory thread, run and messages. A transaction takes the thread row lock on its first
 * thread write or `FOR UPDATE` and keeps it until it ends, like a Postgres row lock; the
 * unique (thread, seq) index rejects a second message at one seq. Leaving `running`
 * releases the run's held place, as the trigger on runs does.
 */
function replyPlaceStore(run: { status?: string; threadId?: string } = {}) {
  const state = {
    nextMessageSeq: 5,
    nextEventSeq: 0,
    run: {
      threadId: run.threadId ?? "thread-1",
      status: run.status ?? "running",
      replySeq: null as number | null,
    },
    seqs: [] as number[],
  };
  let lockOwner: object | null = null;
  const waiters: Array<() => void> = [];
  const lock = async (owner: object) => {
    while (lockOwner && lockOwner !== owner) await new Promise<void>((wake) => waiters.push(wake));
    lockOwner = owner;
  };
  const client = (owner: object) => ({
    $queryRaw: vi.fn(async () => {
      await lock(owner);
      return [];
    }),
    thread: {
      update: vi.fn(
        async ({ data }: { data: { nextMessageSeq?: unknown; nextEventSeq?: unknown } }) => {
          await lock(owner);
          if (data.nextMessageSeq) state.nextMessageSeq += 1;
          if (data.nextEventSeq) state.nextEventSeq += 1;
          return { nextMessageSeq: state.nextMessageSeq, nextEventSeq: state.nextEventSeq };
        },
      ),
    },
    run: {
      findUnique: vi.fn(async () => ({
        ...state.run,
        startedAt: null,
        originDeviceGrantId: null,
        remoteRootTaskId: null,
        delegationId: null,
        delegationRootTaskId: null,
      })),
      update: vi.fn(async ({ data }: { data: { replySeq?: number | null; status?: string } }) => {
        Object.assign(state.run, data);
        if (state.run.status !== "running") state.run.replySeq = null;
        return state.run;
      }),
    },
    message: {
      create: vi.fn(async ({ data }: { data: { seq: number } & Record<string, unknown> }) => {
        if (state.seqs.includes(data.seq))
          throw new Error("Unique constraint failed on the fields: (`threadId`,`seq`)");
        state.seqs.push(data.seq);
        return { id: `message-${data.seq}`, ...data };
      }),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "e", ...data })),
    },
  });
  let last: ReturnType<typeof client> | undefined;
  const transaction = async <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => {
    const owner = {};
    last = client(owner);
    try {
      return await work(last as unknown as Prisma.TransactionClient);
    } finally {
      if (lockOwner === owner) {
        lockOwner = null;
        for (const wake of waiters.splice(0)) wake();
      }
    }
  };
  const streamText = (text: string) =>
    transaction((tx) =>
      appendEventInTransaction(tx, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        type: "thread.progress",
        runId: "run-1",
        payload: { delta: text, streaming: true },
      }),
    );
  const save = (input: Omit<CreateThreadMessageInput, "threadId">) =>
    transaction((tx) => createThreadMessageInTransaction(tx, { threadId: "thread-1", ...input }));
  return { state, streamText, save, lastClient: () => last! };
}

describe("createThreadMessageInTransaction", () => {
  it("allows an automated bot message to opt out of unread without changing the default", async () => {
    const silent = transaction();
    await createThreadMessageInTransaction(silent as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "steps", steps: [{ label: "Checked status", count: 1 }] }],
      markUnread: false,
    });
    expect(silent.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: undefined }) }),
    );

    const visible = transaction();
    await createThreadMessageInTransaction(visible as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "text", text: "Daily report ready" }],
    });
    expect(visible.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: true }) }),
    );
  });
});

describe("run reply place", () => {
  it("holds the reply's place from its first visible text and fills it when the reply saves", async () => {
    const { state, streamText, save } = replyPlaceStore();

    // The run's text is on screen from this point; its place is held at seq 5.
    await streamText("Rad shipped ");
    expect(state.run.replySeq).toBe(5);
    expect(state.nextMessageSeq).toBe(6);

    // More text for the same draft keeps the one place.
    await streamText("the release.");
    expect(state.nextMessageSeq).toBe(6);

    // The owner sends a message while the run is still active; it lands after the reply.
    const question = await save({
      role: "user",
      blocks: [{ kind: "text", text: "any pending PRs left?" }],
    });
    expect(question.seq).toBe(6);

    // The reply saves into the held place, above the owner's question.
    const reply = await save({
      role: "bot",
      runId: "run-1",
      blocks: [{ kind: "text", text: "Rad shipped the release." }],
    });
    expect(reply.seq).toBe(5);
    expect(state.run.replySeq).toBeNull();
  });

  it("keeps the place past bot cards without reply text until the final message saves", async () => {
    const { state, streamText, save } = replyPlaceStore();
    await streamText("Let me chart it");

    // Mid-run cards (commands, attachments, computer prompts) are not the reply.
    const card = await save({
      role: "bot",
      runId: "run-1",
      blocks: [{ kind: "computer", state: "Needs you", text: "sign in" }],
    });
    expect(card.seq).toBe(6);
    expect(state.run.replySeq).toBe(5);

    // Finalizing reads the place, then leaves `running`, which releases it; the final
    // message still fills it, even without text.
    const held = state.run.replySeq;
    state.run.status = "completed";
    state.run.replySeq = null;
    const reply = await save({
      role: "bot",
      runId: "run-1",
      blocks: [{ kind: "steps", steps: [{ label: "Run tests", count: 2 }] }],
      heldReplySeq: held,
    });
    expect(reply.seq).toBe(5);
    expect(state.nextMessageSeq).toBe(7);
  });

  it("allocates at the counter when no place is held", async () => {
    const { state, save } = replyPlaceStore();
    const message = await save({
      role: "bot",
      runId: "run-1",
      blocks: [{ kind: "text", text: "done." }],
    });
    expect(message.seq).toBe(5);
    expect(state.nextMessageSeq).toBe(6);
    expect(state.run.replySeq).toBeNull();
  });

  it("holds a new place once another message of the run filled the first", async () => {
    const { state, streamText, save } = replyPlaceStore();
    await streamText("interim note");
    const first = await save({
      role: "bot",
      runId: "run-1",
      blocks: [{ kind: "text", text: "interim note" }],
    });
    expect(first.seq).toBe(5);

    await streamText("the answer");
    expect(state.run.replySeq).toBe(6);
  });

  it("reads the run once per streamed delta", async () => {
    const { streamText, lastClient } = replyPlaceStore();
    await streamText("first words");
    expect(lastClient().run.findUnique).toHaveBeenCalledTimes(1);
    await streamText(" and more");
    expect(lastClient().run.findUnique).toHaveBeenCalledTimes(1);
  });

  it("does not spend a seq on text streamed after the run left running", async () => {
    const { state, streamText } = replyPlaceStore({ status: "completed" });
    await streamText("late delta");
    expect(state.nextMessageSeq).toBe(5);
    expect(state.run.replySeq).toBeNull();
  });

  it("gives two text messages of one run that save at once separate places", async () => {
    const { state, streamText, save } = replyPlaceStore();
    await streamText("Two updates coming");
    expect(state.run.replySeq).toBe(5);

    // Parallel tool calls can save two messages of one run in overlapping transactions.
    const [first, second] = await Promise.all([
      save({ role: "bot", runId: "run-1", blocks: [{ kind: "text", text: "update one" }] }),
      save({ role: "bot", runId: "run-1", blocks: [{ kind: "text", text: "update two" }] }),
    ]);

    expect([first.seq, second.seq].sort()).toEqual([5, 6]);
    expect(state.run.replySeq).toBeNull();
    expect(state.nextMessageSeq).toBe(7);
  });
});
