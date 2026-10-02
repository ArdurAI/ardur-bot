import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage } from "./thread-target.js";

function fixture(waiting = false) {
  let seq = 0;
  const messages: any[] = [];
  const events: any[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "room" }]),
    thread: {
      update: vi.fn(async ({ data }: any) =>
        data.nextMessageSeq ? { nextMessageSeq: ++seq } : { nextEventSeq: events.length + 1 },
      ),
    },
    chatGroup: {
      findFirst: vi.fn(async () => ({
        members: ["chief", "worker"].map((id) => ({ bot: { id, name: id, color: "ink" } })),
      })),
      findUnique: vi.fn(async () => ({ coordinatorBotId: "chief" })),
      update: vi.fn(),
    },
    space: { findUnique: vi.fn(async () => ({ coordinatorBotId: "chief" })) },
    message: {
      create: vi.fn(async ({ data }: any) => {
        const row = { ...data, id: `message-${seq}`, createdAt: new Date(), sourceRuns: [] };
        messages.push(row);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where }: any) =>
          messages.find(
            (message) => message.clientNonce === where.threadId_clientNonce?.clientNonce,
          ) ?? null,
      ),
      update: vi.fn(),
    },
    event: {
      create: vi.fn(async ({ data }: any) => {
        const row = { ...data, id: `event-${events.length}`, createdAt: new Date() };
        events.push(row);
        return row;
      }),
      findFirst: vi.fn(async () => events.at(-1)),
    },
    run: {
      findMany: vi.fn(async () =>
        waiting ? [{ id: "waiting", taskId: "task", botId: "chief", status: "waiting_input" }] : [],
      ),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "run", taskId: "task", botId: "chief", status: "queued" })),
      findUnique: vi.fn(async () => ({ status: "queued" })),
    },
    task: { create: vi.fn(async () => ({ id: "task" })) },
    chiefPlan: { create: vi.fn(async () => ({ id: "plan", revision: 1 })) },
    chiefAssignment: { upsert: vi.fn() },
    bot: { findMany: vi.fn(async () => []) },
    mcpServer: { findMany: vi.fn(async () => []) },
    computerExecutionLease: { findMany: vi.fn(async () => []) },
    botBrief: { findMany: vi.fn(async () => []) },
    steeringMessage: { create: vi.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (work: any) => work(tx)),
  } as unknown as PrismaClient;
  const actor = { userId: "owner", spaceId: "space" } as Actor;
  const target = {
    kind: "group",
    groupId: "room",
    threadId: "thread",
    members: [],
    memberBotIds: ["chief", "worker"],
  } as ThreadTarget;
  const deps = {
    prisma,
    events: { notify: vi.fn(async () => undefined) } as never,
    jobs: { enqueue: vi.fn(async () => undefined) } as never,
  };
  return { tx, messages, events, actor, target, deps };
}
describe("chief room admission", () => {
  it.each([false, true])(
    "greets without a run, approval answer, steering or cancellation (waiting=%s)",
    async (waiting) => {
      const f = fixture(waiting);
      const sent = await sendThreadMessage(f.deps, f.actor, f.target, {
        text: "Hi everyone.",
        clientNonce: "greeting",
      });
      expect(sent).toMatchObject({
        kind: "receipt-only",
        receipt: { text: "Hi everyone.", botId: "chief" },
      });
      expect(sent).not.toHaveProperty("runId");
      expect(f.tx.run.findMany).not.toHaveBeenCalled();
      expect(f.tx.run.create).not.toHaveBeenCalled();
      expect(f.tx.task.create).not.toHaveBeenCalled();
      expect(f.tx.steeringMessage.create).not.toHaveBeenCalled();
      const replay = await sendThreadMessage(f.deps, f.actor, f.target, {
        text: "Hi everyone.",
        clientNonce: "greeting",
      });
      expect(replay).toEqual(sent);
      expect(f.messages).toHaveLength(2);
      expect(f.events).toHaveLength(2);
    },
  );
  it("returns a durable work receipt without waiting for stalled job publication or realtime", async () => {
    const f = fixture();
    const stalled = new Promise<void>(() => {});
    f.deps.events = { notify: vi.fn(() => stalled) } as never;
    f.deps.jobs = { enqueue: vi.fn(() => stalled) } as never;
    const result = await sendThreadMessage(f.deps, f.actor, f.target, {
      text: "Put this long document in Notion.",
      clientNonce: "work",
    });
    expect(result).toMatchObject({
      kind: "work",
      taskId: "task",
      runId: "run",
      receipt: { key: "document-to-service" },
    });
    expect(f.tx.chiefPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceRunId: "run",
          policyVersion: 1,
          decision: { kind: "plan" },
        }),
      }),
    );
    expect(f.events.map((event) => event.type)).toEqual([
      "thread.message.created",
      "thread.message.created",
    ]);
  });
  it("a rejected room send creates no successful-looking receipt", async () => {
    const f = fixture();
    f.tx.$queryRaw.mockResolvedValueOnce([]);
    await expect(
      sendThreadMessage(f.deps, f.actor, f.target, { text: "Hi everyone." }),
    ).rejects.toThrow();
    expect(f.messages).toHaveLength(0);
    expect(f.events).toHaveLength(0);
  });
});
