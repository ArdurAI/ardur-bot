import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { createThreadMessageInTransaction, reserveRunReplySeqInTransaction } from "./messages.js";

function transaction() {
  return {
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
    run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
  };
}

/** Stateful thread/run pair that behaves like the seq counter and reservation columns. */
function threadWithRun() {
  const state = { nextMessageSeq: 5, replySeq: null as number | null };
  const tx = {
    thread: {
      update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) => {
        if (data.nextMessageSeq) return { nextMessageSeq: ++state.nextMessageSeq };
        return { nextMessageSeq: state.nextMessageSeq };
      }),
    },
    run: {
      findUnique: vi.fn(async () => ({ status: "running", replySeq: state.replySeq })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { replySeq?: null };
          data: { replySeq: number | null };
        }) => {
          if (where.replySeq === null && state.replySeq !== null) return { count: 0 };
          state.replySeq = data.replySeq;
          return { count: 1 };
        },
      ),
      update: vi.fn(async ({ data }: { data: { replySeq: number | null } }) => {
        state.replySeq = data.replySeq;
        return {};
      }),
    },
    message: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "m", ...data })),
    },
  };
  return { state, tx: tx as unknown as Prisma.TransactionClient };
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

describe("run reply seq reservation", () => {
  it("reserves the reply's place at first visible text and fills it when the reply saves", async () => {
    const { state, tx } = threadWithRun();

    // The run's text is on screen from this point; its place is held at seq 5.
    await reserveRunReplySeqInTransaction(tx, {
      threadId: "thread-1",
      runId: "run-1",
      currentReplySeq: state.replySeq,
    });
    expect(state.replySeq).toBe(5);
    expect(state.nextMessageSeq).toBe(6);

    // Reserving again is a no-op: one place per streamed draft.
    await reserveRunReplySeqInTransaction(tx, {
      threadId: "thread-1",
      runId: "run-1",
      currentReplySeq: state.replySeq,
    });
    expect(state.nextMessageSeq).toBe(6);

    // The owner sends a message while the run is still active; it lands after the reply.
    const question = await createThreadMessageInTransaction(tx, {
      threadId: "thread-1",
      role: "user",
      blocks: [{ kind: "text", text: "any pending PRs left?" }],
    });
    expect(question.seq).toBe(6);

    // The run ends and its reply fills the reserved place, above the owner's question.
    const reply = await createThreadMessageInTransaction(tx, {
      threadId: "thread-1",
      role: "bot",
      runId: "run-1",
      blocks: [{ kind: "text", text: "Chief's summary" }],
    });
    expect(reply.seq).toBe(5);
    expect(state.replySeq).toBeNull();
  });

  it("holds the place past bot cards without reply text until the final message saves", async () => {
    const { state, tx } = threadWithRun();
    await reserveRunReplySeqInTransaction(tx, {
      threadId: "thread-1",
      runId: "run-1",
      currentReplySeq: state.replySeq,
    });

    // Mid-run cards (commands, attachments, computer prompts) are not the reply.
    const card = await createThreadMessageInTransaction(tx, {
      threadId: "thread-1",
      role: "bot",
      runId: "run-1",
      blocks: [{ kind: "computer", state: "Needs you", text: "sign in" }],
    });
    expect(card.seq).toBe(6);
    expect(state.replySeq).toBe(5);

    // A tool-only completion still takes the place its streaming reserved.
    const reply = await createThreadMessageInTransaction(tx, {
      threadId: "thread-1",
      role: "bot",
      runId: "run-1",
      blocks: [{ kind: "steps", steps: [{ label: "Run tests", count: 2 }] }],
      consumeReservedReplySeq: true,
    });
    expect(reply.seq).toBe(5);
    expect(state.replySeq).toBeNull();
  });

  it("allocates at the counter when no reservation exists", async () => {
    const { state, tx } = threadWithRun();
    const message = await createThreadMessageInTransaction(tx, {
      threadId: "thread-1",
      role: "bot",
      runId: "run-1",
      blocks: [{ kind: "text", text: "done." }],
    });
    expect(message.seq).toBe(5);
    expect(state.nextMessageSeq).toBe(6);
    expect(state.replySeq).toBeNull();
  });

  it("ignores a reservation that another message of the same run already consumed", async () => {
    const { state, tx } = threadWithRun();
    await reserveRunReplySeqInTransaction(tx, {
      threadId: "thread-1",
      runId: "run-1",
      currentReplySeq: state.replySeq,
    });
    const first = await createThreadMessageInTransaction(tx, {
      threadId: "thread-1",
      role: "bot",
      runId: "run-1",
      blocks: [{ kind: "text", text: "interim note" }],
    });
    expect(first.seq).toBe(5);
    // The next reply text reserves anew at the counter instead of reusing 5.
    await reserveRunReplySeqInTransaction(tx, {
      threadId: "thread-1",
      runId: "run-1",
      currentReplySeq: state.replySeq,
    });
    expect(state.replySeq).toBe(6);
  });
});
