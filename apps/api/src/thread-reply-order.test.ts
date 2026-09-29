import type { PrismaClient } from "@ardurbot/db";
import { appendEvent, finalizeRun, pauseRunForInput, sendUserMessage } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";

/**
 * The owner's group chat, 2026-09-28: the bot's summary streamed on screen, the owner
 * read it and asked a follow-up while the run was still active, and the run saved its
 * reply only when it finished. After a refresh the follow-up sat above the summary it
 * came after. The reply's place must be held from its first visible text, so the saved
 * reply stays above the follow-up.
 */
function evidenceStore() {
  const threads = new Map<string, { nextMessageSeq: number; nextEventSeq: number }>([
    ["thread-1", { nextMessageSeq: 0, nextEventSeq: 0 }],
  ]);
  const threadState = (id: string | undefined) => {
    const existing = id ? threads.get(id) : undefined;
    if (existing) return existing;
    const fresh = { nextMessageSeq: 0, nextEventSeq: 0 };
    threads.set(id ?? "thread-1", fresh);
    return fresh;
  };
  const messages: Array<{ id: string; seq: number; role: string; blocks: unknown }> = [];
  const run = {
    id: "run-chief",
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-chief",
    taskId: "task-1",
    status: "running",
    trigger: "user",
    startedAt: new Date("2026-09-28T14:28:27Z"),
    originDeviceGrantId: null,
    remoteRootTaskId: null,
    delegationId: null as string | null,
    delegationRootTaskId: null,
    replySeq: null as number | null,
  };
  // Leaving `running` releases the held place, as the trigger on runs does.
  const released = () => {
    if (run.status !== "running") run.replySeq = null;
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    thread: {
      update: vi.fn(
        async ({ where, data }: { where?: { id?: string }; data: Record<string, unknown> }) => {
          const state = threadState(where?.id);
          const unreadOnly = !data.nextMessageSeq && !data.nextEventSeq;
          if (data.nextMessageSeq) state.nextMessageSeq += 1;
          if (data.nextEventSeq) state.nextEventSeq += 1;
          return unreadOnly || !data.nextMessageSeq
            ? { nextEventSeq: state.nextEventSeq, nextMessageSeq: state.nextMessageSeq }
            : { nextMessageSeq: state.nextMessageSeq };
        },
      ),
    },
    message: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `message-${messages.length}`, createdAt: new Date(), ...data };
        messages.push(row as (typeof messages)[number]);
        return row;
      }),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `event-${threadState(data.threadId as string).nextEventSeq}`,
        threadId: "thread-1",
        createdAt: new Date(),
        ...data,
      })),
      findFirst: vi.fn(async () => null),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    run: {
      findUnique: vi.fn(async () => ({ ...run })),
      findFirst: vi.fn(async () => ({ ...run })),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => run),
      update: vi.fn(async ({ data }: { data: { replySeq?: number | null } }) => {
        if ("replySeq" in data) run.replySeq = data.replySeq ?? null;
        released();
        return run;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { replySeq?: null; status?: string };
          data: { replySeq?: number | null; status?: string };
        }) => {
          if (where.replySeq === null && run.replySeq !== null) return { count: 0 };
          if (data.replySeq !== undefined) run.replySeq = data.replySeq;
          if (data.status) run.status = data.status;
          released();
          return { count: 1 };
        },
      ),
    },
    attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    task: {
      create: vi.fn(async () => ({ id: "task-2" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    steeringMessage: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    botMessageWake: { findMany: vi.fn(async () => []) },
    botMessageDelivery: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    bot: { update: vi.fn(async () => ({})) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    message: tx.message,
    run: tx.run,
    botMessageWake: { findFirst: vi.fn(async () => null) },
  } as unknown as PrismaClient;
  return { prisma, tx, run, messages };
}

describe("thread reply order", () => {
  it("keeps a streamed reply above the follow-up the owner sent before the run ended", async () => {
    const { prisma, run, messages } = evidenceStore();
    const scope = { spaceId: "space-1", threadId: "thread-1", botId: "bot-chief" };

    // The reply's summary text streams on screen while the run is still active.
    await appendEvent(prisma, {
      ...scope,
      type: "thread.progress",
      runId: run.id,
      payload: { text: "Rad shipped the release and closed the blockers.", streaming: true },
    });
    expect(run.replySeq).toBe(0);

    // The owner reads it and asks a follow-up; the run is still working.
    const sent = await sendUserMessage(prisma, {
      ...scope,
      userId: "user-1",
      blocks: [{ kind: "text", text: "does the 90.0 release have any pending PRs left?" }],
      prompt: "does the 90.0 release have any pending PRs left?",
      trigger: "user",
    });
    expect(sent.runId).toBe(run.id);

    // Only when the run finishes does its reply become a saved message.
    const finished = await finalizeRun(prisma, {
      ...scope,
      runId: run.id,
      taskId: run.taskId,
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseFence: 1,
      outcome: "completed",
      blocks: [{ kind: "text", text: "Rad shipped the release and closed the blockers." }],
    });
    expect(finished).not.toBe(false);

    const ordered = [...messages].sort((a, b) => a.seq - b.seq);
    expect(ordered.map((message) => message.role)).toEqual(["bot", "user"]);
    expect(ordered[0]).toMatchObject({
      role: "bot",
      runId: run.id,
      seq: 0,
      blocks: [{ kind: "text", text: "Rad shipped the release and closed the blockers." }],
    });
    expect(ordered[1]).toMatchObject({ role: "user", seq: 1 });
    expect(run.replySeq).toBeNull();
  });

  it("does not reserve a place for tool activity lines", async () => {
    const { prisma, run } = evidenceStore();

    await appendEvent(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-chief",
      type: "thread.progress",
      runId: run.id,
      payload: { text: "Running gh pr list", activity: true },
    });

    expect(run.replySeq).toBeNull();
  });

  it("fills the held place with the ask card saved by a pause for input", async () => {
    const { prisma, run, messages } = evidenceStore();
    const scope = { spaceId: "space-1", threadId: "thread-1", botId: "bot-chief" };

    // The reply starts streaming: its place is held at seq 0.
    await appendEvent(prisma, {
      ...scope,
      type: "thread.progress",
      runId: run.id,
      payload: { text: "Before I run that, I need ", streaming: true },
    });
    expect(run.replySeq).toBe(0);

    // The owner asks a question while the reply is still streaming; it takes seq 1.
    await sendUserMessage(prisma, {
      ...scope,
      userId: "user-1",
      blocks: [{ kind: "text", text: "which environment did you mean?" }],
      prompt: "which environment did you mean?",
      trigger: "user",
    });
    expect(messages.at(-1)).toMatchObject({ role: "user", seq: 1 });

    // The run pauses for input. The status change releases the hold, so the card
    // must be saved with the place read before that change.
    const paused = await pauseRunForInput(prisma, {
      ...scope,
      runId: run.id,
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseFence: 1,
      blocks: [{ kind: "ask", text: "Which environment?", status: "pending" }],
    });
    expect(paused).toBe(true);

    const ordered = [...messages].sort((a, b) => a.seq - b.seq);
    expect(ordered.map((message) => message.role)).toEqual(["bot", "user"]);
    expect(ordered[0]).toMatchObject({
      role: "bot",
      runId: run.id,
      seq: 0,
      blocks: [{ kind: "ask", text: "Which environment?", status: "pending" }],
    });
    expect(ordered[1]).toMatchObject({ role: "user", seq: 1 });
    expect(run.replySeq).toBeNull();
  });

  it("does not fill a delegated pause card into another thread's held place", async () => {
    const { prisma, tx, run, messages } = evidenceStore();
    // The run belongs to a delegation; its ask cards land on the coordinator thread.
    run.delegationId = "delegation-1";
    const coordinator = { coordinatorThreadId: "thread-coord", coordinatorBotId: "bot-coord" };
    Object.assign(tx, {
      delegation: {
        findUnique: vi.fn(async () => ({
          id: "delegation-1",
          actingBotId: "bot-chief",
          actingName: "Chief",
          admissionKey: "message:1",
        })),
        findUniqueOrThrow: vi.fn(async () => ({
          id: "delegation-1",
          kind: "message",
          rootTaskId: "task-root",
        })),
      },
      delegationRoot: { findUniqueOrThrow: vi.fn(async () => coordinator) },
    });

    await appendEvent(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-chief",
      type: "thread.progress",
      runId: run.id,
      payload: { text: "I will ask the coordinator ", streaming: true },
    });
    expect(run.replySeq).toBe(0);

    const paused = await pauseRunForInput(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-chief",
      runId: run.id,
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseFence: 1,
      blocks: [{ kind: "ask", text: "Allow this?", status: "pending" }],
    });
    expect(paused).toBe(true);

    // The card lands on the coordinator thread and takes that thread's next place,
    // not the reply place the run holds in its own thread.
    const card = messages.find((message) => message.threadId === "thread-coord");
    expect(card).toMatchObject({ role: "bot", runId: run.id, seq: 0 });
    const ownThreadCard = messages.find(
      (message) => message.threadId === "thread-1" && message.role === "bot",
    );
    expect(ownThreadCard).toBeUndefined();
  });
});
