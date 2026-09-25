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
  kind: "device",
  trustedAt: new Date("2026-09-24T05:00:00Z"),
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
    space: { findUniqueOrThrow: vi.fn(async () => ({ requireTrustedDevices: true })) },
    delegationRoot: { updateMany: vi.fn(async () => ({ count: 0 })) },
    delegation: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
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
    remoteAuthorityPolicy: {
      findMany: vi.fn(async () => [] as { layer: string; scopes: string[] }[]),
    },
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
  it.each([undefined, "task-a"])(
    "rechecks trust before dispatch or steering (%s)",
    async (replyToTaskId) => {
      const f = fixture();
      const pending = { ...grant, trustedAt: null };
      f.tx.deviceGrant.findFirst.mockResolvedValue(pending);
      const input = { clientNonce: "pending-device-nonce", text: "Do this task", replyToTaskId };
      await expect(admitDispatch(f.db, grant, input)).rejects.toThrow("approve this device");
      expect(f.tx.task.create).not.toHaveBeenCalled();
      expect(f.tx.steeringMessage.create).not.toHaveBeenCalled();
      expect(f.tx.dispatchReceipt.create).not.toHaveBeenCalled();
      f.tx.deviceGrant.findFirst.mockResolvedValue(grant);
      await expect(admitDispatch(f.db, grant, input)).resolves.toMatchObject({ state: "accepted" });
    },
  );
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

describe("channel admission uses the P1 transaction", () => {
  function channelFixture() {
    const f = fixture();
    const channelGrant = {
      ...grant,
      kind: "channel",
      installationId: "installation",
      provider: "telegram",
      workspaceId: "telegram",
      senderId: "sender",
    };
    f.tx.deviceGrant.findFirst.mockResolvedValue(channelGrant);
    const chat = {
      externalConversation: { create: vi.fn(async () => ({ thread: { id: "chat-thread" } })) },
      chatInstallation: { findFirst: vi.fn(async () => ({ id: "installation", botId: "bot-a" })) },
      messagingRoute: { findUnique: vi.fn(async () => null), upsert: vi.fn() },
      messagingTaskOrigin: { create: vi.fn(), findFirst: vi.fn(async () => ({ runId: "run-a" })) },
      chatOutbox: {
        findUnique: vi.fn(async () => null),
        count: vi.fn(async () => 0),
        upsert: vi.fn(),
      },
    };
    Object.assign(f.tx, chat);
    Object.assign(f.tx.thread, { create: vi.fn(async () => ({ id: "chat-thread" })) });
    Object.assign(f.tx.dispatchReceipt, { count: vi.fn(async () => 0) });
    const origin = {
      installationId: "installation",
      provider: "telegram" as const,
      workspaceId: "telegram",
      channelId: "channel",
      messageId: "provider-message",
      private: false,
    };
    return { ...f, chat, channelGrant, origin };
  }
  it("creates one isolated task and immutable origin even after a receiver/default-bot restart", async () => {
    const f = channelFixture();
    const input = { text: "Question", clientNonce: "provider-event-nonce" };
    const receipt = await admitDispatch(f.db, f.channelGrant, input, f.origin);
    f.chat.chatInstallation.findFirst.mockResolvedValue({ id: "installation", botId: "bot-b" });
    expect(await admitDispatch(f.db, f.channelGrant, input, f.origin)).toEqual(receipt);
    expect(f.tx.task.create).toHaveBeenCalledOnce();
    expect(f.chat.messagingTaskOrigin.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ taskId: "task-a", botId: "bot-a", channelId: "channel" }),
    });
    expect(f.tx.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ threadId: "chat-thread" }),
    });
    expect(f.chat.chatOutbox.upsert).toHaveBeenCalledOnce();
    expect(f.chat.chatOutbox.upsert.mock.calls[0]?.[0].create.card.text).toBe(
      "Accepted — working on it.",
    );
  });
  it("keeps a private chat on the personal thread shared with home and phones", async () => {
    const f = channelFixture();
    await admitDispatch(
      f.db,
      f.channelGrant,
      { text: "Question", clientNonce: "private-event-nonce" },
      { ...f.origin, private: true },
    );
    expect(f.chat.externalConversation.create).not.toHaveBeenCalled();
    expect(f.tx.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ threadId: "thread-a" }),
    });
  });
  it("steers only an owned origin and rejects changed return destinations on replay", async () => {
    const f = channelFixture();
    const input = { text: "Question", clientNonce: "provider-event-nonce" };
    await admitDispatch(f.db, f.channelGrant, input, f.origin);
    await expect(
      admitDispatch(f.db, f.channelGrant, input, { ...f.origin, channelId: "elsewhere" }),
    ).rejects.toThrow("changed");
    f.clearReceipt();
    // Reaching the task cap must not prevent steering work that already exists.
    f.tx.run.count.mockResolvedValue(20);
    await admitDispatch(f.db, f.channelGrant, { ...input, replyToTaskId: "task-a" }, f.origin);
    expect(f.tx.steeringMessage.create).toHaveBeenCalledOnce();
    expect(f.chat.messagingTaskOrigin.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        grantId: "phone-a",
        channelId: "channel",
        installationId: "installation",
      }),
    });
  });
  it("refuses a channel grant used without its origin and clamps consequential authority", async () => {
    const f = channelFixture();
    await expect(
      admitDispatch(f.db, f.channelGrant, {
        text: "No origin",
        clientNonce: "provider-event-nonce",
      }),
    ).rejects.toThrow("surface");
    expect(f.tx.task.create).not.toHaveBeenCalled();
  });
});

it("rechecks revocation before recording a stop request", async () => {
  const f = fixture();
  f.tx.deviceGrant.findFirst.mockResolvedValueOnce(null as never);
  await expect(requestDispatchStop(f.db, grant, "task-a")).rejects.toThrow("unavailable");
  expect(f.tx.run.updateMany).not.toHaveBeenCalled();
});

it.each([undefined, "task-a"])(
  "refuses database admission while Dispatch is off, including steering %s",
  async (replyToTaskId) => {
    const f = fixture();
    f.tx.remoteAuthorityPolicy.findMany.mockResolvedValue([
      { layer: "desktop-dispatch", scopes: [] },
    ]);
    await expect(
      admitDispatch(f.db, grant, {
        clientNonce: "off",
        text: "Work",
        ...(replyToTaskId ? { replyToTaskId } : {}),
      }),
    ).rejects.toThrow("Dispatch is off on this computer");
    expect(f.tx.task.create).not.toHaveBeenCalled();
    expect(f.tx.dispatchReceipt.create).not.toHaveBeenCalled();
  },
);
