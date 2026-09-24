import { ALL_DEVICE_SCOPES } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { DeviceGrant, PrismaClient } from "./client.js";
import {
  admitDispatch,
  confirmDispatchStop,
  dispatchState,
  inheritedRemoteOrigin,
  persistDispatchSummary,
  requestDispatchStop,
} from "./dispatch.js";

const grant = {
  id: "phone-a",
  instanceId: "home",
  spaceId: "space",
  userId: "owner",
  scopes: [...ALL_DEVICE_SCOPES],
  defaultBotId: "bot-a",
  revokedAt: null,
} as DeviceGrant;
function fixture() {
  let receipt: Record<string, unknown> | null = null;
  let run = {
    id: "run-a",
    botId: "bot-a",
    taskId: "task-a",
    spaceId: "space",
    userId: "owner",
    threadId: "thread-a",
    status: "queued",
    originDeviceGrantId: "phone-a",
    remoteRootTaskId: "task-a",
    remoteDeviceGrantIds: ["phone-a"],
    cancelRequestedAt: null as Date | null,
    cancelConfirmedAt: null as Date | null,
  };
  const bot = { id: "bot-a", spaceId: "space", userId: "owner", thread: { id: "thread-a" } };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    deviceGrant: { findFirst: vi.fn(async () => grant) },
    dispatchReceipt: {
      findUnique: vi.fn(async () => receipt),
      create: vi.fn(async ({ data }) => {
        receipt = data;
        return data;
      }),
    },
    task: {
      create: vi.fn(async () => ({ id: "task-a" })),
      findFirst: vi.fn(async () => ({ id: "task-a", botId: "bot-a" })),
      update: vi.fn(async () => ({})),
    },
    run: {
      findUnique: vi.fn(async () => run),
      findFirst: vi.fn(async () => run),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => {
        run = { ...run, ...data };
        return run;
      }),
      update: vi.fn(async ({ data }) => {
        run = { ...run, ...data };
        return run;
      }),
      updateMany: vi.fn(async ({ data }) => {
        run = { ...run, ...data };
        return { count: 1 };
      }),
    },
    bot: { findFirst: vi.fn(async () => bot) },
    thread: { update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 2 })) },
    message: {
      create: vi.fn(async ({ data }) => ({ id: "message", ...data })),
      update: vi.fn(async () => ({})),
    },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
    steeringMessage: { create: vi.fn(async () => ({})) },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "membership" })) },
    instanceIdentity: {
      findUnique: vi.fn(async () => ({ instanceId: "home", scopes: ALL_DEVICE_SCOPES })),
    },
    remoteAuthorityPolicy: { findMany: vi.fn(async () => []) },
    deviceAuditEvent: { create: vi.fn(async () => ({})) },
    attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    dispatchSummary: { upsert: vi.fn(async (_input: unknown) => ({})) },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  return {
    db,
    tx,
    run: () => run,
    clearReceipt: () => {
      receipt = null;
    },
  };
}
describe("durable Dispatch admission", () => {
  it("returns the original task on retry and conflicts when the body changes", async () => {
    const f = fixture();
    const input = { clientNonce: "same-client-nonce", text: "Do this task" };
    const first = await admitDispatch(f.db, grant, input);
    expect(first.state).toBe("accepted");
    expect(await admitDispatch(f.db, { ...grant, defaultBotId: "bot-b" }, input)).toEqual(first);
    expect(f.tx.task.create).toHaveBeenCalledOnce();
    await expect(admitDispatch(f.db, grant, { ...input, text: "Different task" })).rejects.toThrow(
      "changed",
    );
    expect(f.tx.task.create).toHaveBeenCalledOnce();
    expect(f.tx.dispatchReceipt.create.mock.calls[0]![0].data).toMatchObject({
      deviceGrantId: "phone-a",
      botId: "bot-a",
    });
  });
  it("creates a new Task while work is queued, but a targeted reply steers the existing task", async () => {
    const f = fixture();
    await admitDispatch(f.db, grant, { clientNonce: "new-task-nonce-01", text: "A new task" });
    expect(f.tx.task.create).toHaveBeenCalledOnce();
    expect(f.tx.steeringMessage.create).not.toHaveBeenCalled();
    f.clearReceipt();
    await admitDispatch(f.db, grant, {
      clientNonce: "reply-task-nonce",
      text: "Use the other file",
      replyToTaskId: "task-a",
    });
    expect(f.tx.task.create).toHaveBeenCalledOnce();
    expect(f.tx.steeringMessage.create).toHaveBeenCalledOnce();
  });
  it("two devices use the same authorized thread and steering adds the second ceiling", async () => {
    const f = fixture();
    const second = { ...grant, id: "phone-b" };
    f.tx.deviceGrant.findFirst.mockResolvedValue(second);
    const result = await admitDispatch(f.db, second, {
      clientNonce: "reply-from-phone-b",
      botId: "bot-a",
      text: "Also check this",
      replyToTaskId: "task-a",
    });
    expect(result.threadId).toBe("thread-a");
    expect(f.run().originDeviceGrantId).toBe("phone-a");
    expect(f.run().remoteDeviceGrantIds).toEqual(["phone-a", "phone-b"]);
    expect(f.tx.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "owner", spaceId: "space" }),
      }),
    );
  });
  it("keeps a stop request nonterminal until executor confirmation", async () => {
    const f = fixture();
    await requestDispatchStop(f.db, grant, "task-a");
    expect(f.run().cancelRequestedAt).not.toBeNull();
    expect(dispatchState(f.run())).toBe("accepted");
    expect(f.tx.dispatchSummary.upsert).not.toHaveBeenCalled();
    await confirmDispatchStop(f.db, "run-a");
    expect(dispatchState(f.run())).toBe("stopped");
    expect(f.tx.dispatchSummary.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ state: "stopped", deviceGrantId: "phone-a" }),
      }),
    );
  });
  it("delegation copies the immutable root and all contributing ceilings", async () => {
    const f = fixture();
    expect(await inheritedRemoteOrigin(f.db, "run-a")).toEqual({
      originDeviceGrantId: "phone-a",
      remoteRootTaskId: "task-a",
      remoteDeviceGrantIds: ["phone-a"],
    });
  });
});

it("delivers one immutable terminal summary to the original device", async () => {
  const f = fixture();
  await persistDispatchSummary(f.db, f.run(), "done", "final-message");
  await persistDispatchSummary(f.db, f.run(), "done", "duplicate-message");
  for (const [input] of f.tx.dispatchSummary.upsert.mock.calls)
    expect(input).toMatchObject({
      where: { taskId: "task-a" },
      update: {},
      create: { deviceGrantId: "phone-a" },
    });
});
it("waits for delegated work before confirming the parent stopped", async () => {
  const f = fixture();
  await requestDispatchStop(f.db, grant, "task-a");
  f.tx.run.count.mockResolvedValue(1);
  expect(await confirmDispatchStop(f.db, "run-a")).toBe(false);
  expect(f.run().cancelConfirmedAt).toBeNull();
  expect(dispatchState({ status: "cancelled" })).not.toBe("stopped");
});
