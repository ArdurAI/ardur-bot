import type { ChiefActivity, ChiefDispatch } from "@ardurbot/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";

vi.mock("./events.js", () => ({
  appendEventInTransaction: vi.fn(async (_tx, event) => ({ ...event, seq: 1 })),
}));
vi.mock("./messages.js", () => ({
  createThreadMessageInTransaction: vi.fn(async (_tx, message) => ({
    ...message,
    id: "result-message",
  })),
}));

import { projectChiefActivity, publishChiefDraftResult } from "./chief-activity.js";
import { appendEventInTransaction } from "./events.js";

const scope = { spaceId: "space", userId: "owner" };
const activity: ChiefActivity = {
  revision: 1,
  runId: "run",
  delegationId: "assignment",
  attempt: 2,
  sourceSeq: 1,
  key: "read-input",
  state: "active",
  updatedAt: "2026-01-01T00:00:00Z",
};
const dispatch: ChiefDispatch = {
  requestMessageId: "request",
  revision: 1,
  runId: "run",
  delegationId: "assignment",
  memberId: "worker",
  memberName: "Member",
  state: "messaged",
  reason: "eligible",
};
function fixture() {
  const plan = {
    id: "plan",
    ...scope,
    threadId: "room",
    groupId: "group",
    chiefBotId: "chief",
    revision: 1,
    sourceMessageId: "request",
    dispatch: { ...dispatch, messageId: "dispatch-message" },
  };
  const run = {
    id: "run",
    delegationId: "assignment",
    leaseFence: 2,
    status: "running",
    cancelRequestedAt: null,
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    chiefPlan: {
      findFirst: vi.fn(async () => plan),
      findUniqueOrThrow: vi.fn(async () => plan),
      update: vi.fn(async () => plan),
    },
    run: { findFirst: vi.fn(async () => run) },
    chatGroup: { findFirst: vi.fn(async () => ({ id: "group" })) },
    message: {
      findFirst: vi.fn(async () => ({
        id: "dispatch-message",
        seq: 3,
        createdAt: new Date("2026-01-01"),
        role: "bot",
        blocks: [
          {
            kind: "handoff",
            fromBotId: "chief",
            toBotId: "worker",
            text: "Private request body",
            chiefDispatch: dispatch,
          },
        ],
      })),
      update: vi.fn(),
      findUnique: vi.fn(async () => null),
    },
    delegation: { findFirst: vi.fn(async () => null) },
  };
  const prisma = {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  return { tx, prisma, plan, run };
}
beforeEach(() => vi.clearAllMocks());
describe("chief scoped durable projection", () => {
  it("updates the existing room dispatch without a new message or model wake", async () => {
    const f = fixture();
    const event = await projectChiefActivity(f.prisma, {
      ...scope,
      planId: "plan",
      botId: "worker",
      activity,
    });
    expect(event).toMatchObject({
      threadId: "room",
      botId: "chief",
      type: "thread.message.updated",
    });
    expect(f.tx.message.update).toHaveBeenCalledTimes(1);
    const blocks = f.tx.message.update.mock.calls[0]![0].data.blocks;
    expect(blocks[0].chiefDispatch.activity).toEqual(activity);
    expect(blocks[0].text).toBe("Private request body");
    expect(event?.payload).not.toHaveProperty("delta");
  });
  it.each([{ revision: 2 }, { runId: "other" }, { attempt: 1 }, { delegationId: "other" }])(
    "rejects a stale or unrelated identity %j",
    async (change) => {
      const f = fixture();
      expect(
        await projectChiefActivity(f.prisma, {
          ...scope,
          planId: "plan",
          botId: "worker",
          activity: { ...activity, ...change },
        }),
      ).toBeUndefined();
      expect(f.tx.message.update).not.toHaveBeenCalled();
    },
  );
  it("rejects revoked membership, cancelled work, and old cursors", async () => {
    const f = fixture();
    f.tx.chatGroup.findFirst.mockResolvedValueOnce(null as never);
    expect(
      await projectChiefActivity(f.prisma, { ...scope, planId: "plan", botId: "worker", activity }),
    ).toBeUndefined();
    f.run.cancelRequestedAt = new Date() as never;
    expect(
      await projectChiefActivity(f.prisma, { ...scope, planId: "plan", botId: "worker", activity }),
    ).toBeUndefined();
    f.run.cancelRequestedAt = null;
    Object.assign(f.plan.dispatch, { activity });
    expect(
      await projectChiefActivity(f.prisma, { ...scope, planId: "plan", botId: "worker", activity }),
    ).toBeUndefined();
    expect(f.tx.message.update).not.toHaveBeenCalled();
  });
  it("persists coalesced cursors but publishes state changes promptly", async () => {
    const f = fixture();
    Object.assign(f.plan.dispatch, { activity, publishedActivity: activity });
    const next = { ...activity, sourceSeq: 2, updatedAt: "2026-01-01T00:00:00.100Z" };
    expect(
      await projectChiefActivity(f.prisma, {
        ...scope,
        planId: "plan",
        botId: "worker",
        activity: next,
      }),
    ).toBeUndefined();
    expect(f.tx.message.update).toHaveBeenCalledTimes(1);
    expect(appendEventInTransaction).not.toHaveBeenCalled();
    f.run.status = "completed";
    await projectChiefActivity(f.prisma, {
      ...scope,
      planId: "plan",
      botId: "worker",
      activity: { ...next, state: "completed" },
    });
    expect(appendEventInTransaction).toHaveBeenCalledTimes(1);
  });
  it("a completed worker link alone cannot publish a verified result", async () => {
    const f = fixture();
    expect(
      await publishChiefDraftResult(f.prisma, {
        ...scope,
        chiefBotId: "chief",
        delegationId: "assignment",
      }),
    ).toBeUndefined();
    expect(appendEventInTransaction).not.toHaveBeenCalled();
  });
});
