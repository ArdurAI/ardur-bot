import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { appendEvent, claimSteering } from "./events.js";
import { createThreadMessage } from "./messages.js";

type StoredRun = {
  id: string;
  threadId: string;
  botId: string;
  status: string;
  replySeq: number | null;
};

/**
 * In-memory thread store. Postgres serializes seq allocation on the thread row; the
 * store applies updates in call order, the same total order the row lock gives.
 */
function threadStore(runs: StoredRun[]) {
  const thread = { nextMessageSeq: 0, nextEventSeq: 0 };
  const byId = new Map(runs.map((run) => [run.id, { ...run }]));
  const messages: Array<{ id: string; seq: number; role: string; runId?: string }> = [];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    thread: {
      update: async ({
        data,
        select,
      }: {
        data: { nextMessageSeq?: { increment: number }; nextEventSeq?: { increment: number } };
        select?: Record<string, boolean>;
      }) => {
        if (data.nextMessageSeq) thread.nextMessageSeq += data.nextMessageSeq.increment;
        if (data.nextEventSeq) thread.nextEventSeq += data.nextEventSeq.increment;
        const out: Record<string, number> = {};
        for (const key of Object.keys(select ?? {})) {
          if (select?.[key])
            out[key] = key === "nextEventSeq" ? thread.nextEventSeq : thread.nextMessageSeq;
        }
        return out;
      },
    },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => byId.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<StoredRun> }) =>
        Object.assign(byId.get(where.id)!, data),
    },
    message: {
      create: async ({ data }: { data: { seq: number; role: string; runId?: string } }) => {
        const message = { id: `message-${messages.length}`, ...data };
        messages.push(message);
        return message;
      },
    },
    event: {
      create: async ({ data }: { data: { seq: number; type: string } }) => ({
        id: `event-${data.seq}`,
        ...data,
        createdAt: new Date(),
      }),
    },
  };
  const prisma = {
    $transaction: (action: (client: typeof tx) => Promise<unknown>) => action(tx),
  } as unknown as PrismaClient;
  return { thread, byId, messages, prisma };
}

describe("reply places under concurrent room runs", () => {
  it("keeps each streaming run's place and saves replies in first-visible-text order", async () => {
    const store = threadStore([
      { id: "run-a", threadId: "thread", botId: "bot-a", status: "running", replySeq: null },
      { id: "run-b", threadId: "thread", botId: "bot-b", status: "running", replySeq: null },
    ]);
    const progress = (botId: string, runId: string, delta: string) =>
      appendEvent(store.prisma, {
        spaceId: "space",
        threadId: "thread",
        botId,
        type: "thread.progress",
        runId,
        payload: { streaming: true, delta },
      });

    // Bot A shows text first, bot B second; both keep streaming.
    await progress("bot-a", "run-a", "hello from A");
    await progress("bot-b", "run-b", "hello from B");
    await progress("bot-a", "run-a", " more A");
    await progress("bot-b", "run-b", " more B");
    const placeA = store.byId.get("run-a")?.replySeq;
    const placeB = store.byId.get("run-b")?.replySeq;
    expect(placeA).toBe(0);
    expect(placeB).toBe(1);
    expect(placeA).not.toBe(placeB);

    // The owner's message meanwhile lands below both held places.
    await createThreadMessage(store.prisma, {
      threadId: "thread",
      role: "user",
      origin: "human-typed",
      blocks: [{ kind: "text", text: "one moment" }],
    });

    // Bot B finishes first; its saved reply still lands after A's place.
    await createThreadMessage(store.prisma, {
      threadId: "thread",
      role: "bot",
      botId: "bot-b",
      runId: "run-b",
      blocks: [{ kind: "text", text: "hello from B more B" }],
    });
    await createThreadMessage(store.prisma, {
      threadId: "thread",
      role: "bot",
      botId: "bot-a",
      runId: "run-a",
      blocks: [{ kind: "text", text: "hello from A more A" }],
    });

    const bySeq = [...store.messages].sort((left, right) => left.seq - right.seq);
    expect(bySeq.map((message) => [message.seq, message.runId ?? "owner"])).toEqual([
      [0, "run-a"],
      [1, "run-b"],
      [2, "owner"],
    ]);
    // Both holds are released once the saved replies filled them.
    expect(store.byId.get("run-a")?.replySeq).toBeNull();
    expect(store.byId.get("run-b")?.replySeq).toBeNull();
    expect(store.thread.nextMessageSeq).toBe(3);
  });
});

describe("steering under concurrent room runs", () => {
  function steeringFixture() {
    const rows = [
      {
        id: "steer-a",
        messageId: "m-a",
        botId: "bot-a",
        runId: "run-a",
        claimedAt: new Date(),
        message: {
          threadId: "thread",
          seq: 3,
          origin: "human-typed",
          actorId: "owner",
          blocks: [{ kind: "text", text: "for A" }],
        },
      },
      {
        id: "steer-b",
        messageId: "m-b",
        botId: "bot-b",
        runId: "run-b",
        claimedAt: new Date(),
        message: {
          threadId: "thread",
          seq: 4,
          origin: "human-typed",
          actorId: "owner",
          blocks: [{ kind: "text", text: "for B" }],
        },
      },
      {
        id: "steer-old",
        messageId: "m-old",
        botId: "bot-a",
        runId: "run-old",
        claimedAt: new Date(),
        message: {
          threadId: "thread",
          seq: 2,
          origin: "human-typed",
          actorId: "owner",
          blocks: [{ kind: "text", text: "for an earlier run of A" }],
        },
      },
      {
        id: "steer-free",
        messageId: "m-free",
        botId: "bot-a",
        runId: null,
        claimedAt: null,
        message: {
          threadId: "thread",
          seq: 5,
          origin: "human-typed",
          actorId: "owner",
          blocks: [{ kind: "text", text: "for whoever answers next" }],
        },
      },
    ];
    const runs: Record<string, { id: string; delegationId: null }> = {
      "run-a": { id: "run-a", delegationId: null },
      "run-b": { id: "run-b", delegationId: null },
    };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => runs[where.id] ?? null),
      },
      delegation: { findUnique: vi.fn(async () => null) },
      steeringMessage: {
        findMany: vi.fn(
          async ({
            where,
          }: {
            where: {
              botId: string;
              OR: Array<{ runId: string | null }>;
              message: { threadId: string };
            };
          }) =>
            rows.filter(
              (row) =>
                row.botId === where.botId &&
                row.message.threadId === where.message.threadId &&
                where.OR.some((clause) => row.runId === clause.runId),
            ),
        ),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      botMessageWake: { updateMany: vi.fn(async () => ({ count: 0 })) },
      steeringSummary: { upsert: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: (action: (client: typeof tx) => Promise<unknown>) => action(tx),
    } as unknown as PrismaClient;
    return { prisma };
  }

  const lease = { leaseOwner: "worker", leaseFence: 1, seenIds: [] as string[] };

  it("delivers each message to exactly the run the routing rule selected", async () => {
    const { prisma } = steeringFixture();
    const forA = await claimSteering(prisma, {
      threadId: "thread",
      botId: "bot-a",
      runId: "run-a",
      ...lease,
    });
    // A's own message and the unbound follow-up — never B's row, never the stale
    // row an earlier run of A left bound to itself.
    expect(forA.map((item) => item.id)).toEqual(["steer-a", "steer-free"]);
    const forB = await claimSteering(prisma, {
      threadId: "thread",
      botId: "bot-b",
      runId: "run-b",
      ...lease,
    });
    expect(forB.map((item) => item.id)).toEqual(["steer-b"]);
  });
});
