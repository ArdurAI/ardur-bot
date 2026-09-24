import type { DispatchInput, DispatchState, DispatchReceipt as Receipt } from "@ardurbot/contracts";
import { ALL_DEVICE_SCOPES, canonicalDispatchJson } from "@ardurbot/contracts";
import type { RemoteAuthority } from "@ardurbot/core";
import { checkRemoteTool, effectiveRemoteAuthority } from "@ardurbot/core";
import type { DeviceGrant, Prisma, PrismaClient } from "./client.js";
import { auditDevice, DeviceRequestError, deviceDigest } from "./device-grants.js";
import { appendEventInTransaction, steerRunInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { withTransactionRetry } from "./transaction-retry.js";

const ACTIVE = ["running", "queued", "leased", "waiting_input", "waiting_takeover"];
export function dispatchState(run: {
  status: string;
  cancelConfirmedAt?: Date | null;
}): DispatchState {
  if (run.cancelConfirmedAt) return "stopped";
  if (run.status === "completed") return "done";
  if (run.status === "failed") return "failed";
  if (run.status === "cancelled") return "failed";
  return ["running", "waiting_input", "waiting_takeover"].includes(run.status)
    ? "running"
    : "accepted";
}
export async function loadRemoteAuthority(
  tx: Prisma.TransactionClient,
  grant: DeviceGrant,
  botId: string,
): Promise<RemoteAuthority> {
  const [home, member, bot, policies] = await Promise.all([
    tx.instanceIdentity.findUnique({ where: { id: "home" } }),
    tx.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: grant.spaceId, userId: grant.userId } },
    }),
    tx.bot.findFirst({
      where: { id: botId, spaceId: grant.spaceId, userId: grant.userId, archivedAt: null },
    }),
    tx.remoteAuthorityPolicy.findMany({
      where: {
        OR: [
          { layer: "space", subjectId: grant.spaceId },
          { layer: "bot", subjectId: botId },
          { layer: "user", subjectId: grant.userId },
        ],
      },
    }),
  ]);
  const layer = (name: string) =>
    policies.find((policy) => policy.layer === name)?.scopes ?? [...ALL_DEVICE_SCOPES];
  return {
    home: home?.instanceId === grant.instanceId ? home.scopes : [],
    space: member ? layer("space") : [],
    bot: bot ? layer("bot") : [],
    user: member ? layer("user") : [],
    device: grant.revokedAt ? [] : grant.scopes,
  };
}
function receiptView(
  record: { taskId: string; runId: string; threadId: string; botId: string },
  run: { status: string; cancelRequestedAt?: Date | null; cancelConfirmedAt?: Date | null },
): Receipt {
  return {
    taskId: record.taskId,
    runId: record.runId,
    threadId: record.threadId,
    botId: record.botId,
    state: dispatchState(run),
    cancelRequested: Boolean(run.cancelRequestedAt),
  };
}
export async function admitDispatch(
  prisma: PrismaClient,
  grant: DeviceGrant,
  input: DispatchInput,
): Promise<Receipt> {
  const key = {
    instanceId: grant.instanceId,
    spaceId: grant.spaceId,
    deviceGrantId: grant.id,
    clientNonce: input.clientNonce,
  };
  const payloadFingerprint = deviceDigest(canonicalDispatchJson(input));
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      // Serializes admission and revocation, including a retry whose routing default has changed.
      await tx.$queryRaw`SELECT id FROM device_grants WHERE id = ${grant.id} FOR UPDATE`;
      const liveGrant = await tx.deviceGrant.findFirst({
        where: { id: grant.id, instanceId: grant.instanceId, revokedAt: null },
      });
      if (!liveGrant) throw new DeviceRequestError("This device is no longer allowed to run work.");
      const replay = await tx.dispatchReceipt.findUnique({
        where: { instanceId_spaceId_deviceGrantId_clientNonce: key },
      });
      if (replay) {
        if (replay.payloadFingerprint !== payloadFingerprint)
          throw new DeviceRequestError("This request changed; send it as a new task.", 409);
        const run = await tx.run.findUnique({ where: { id: replay.runId } });
        if (!run) throw new DeviceRequestError("This task is no longer available.", 409);
        return receiptView(replay, run);
      }
      const botId = input.botId ?? liveGrant.defaultBotId;
      if (!botId) throw new DeviceRequestError("Choose a bot before sending this task.", 400);
      const bot = await tx.bot.findFirst({
        where: { id: botId, spaceId: grant.spaceId, userId: grant.userId, archivedAt: null },
        include: { thread: true },
      });
      if (!bot?.thread)
        throw new DeviceRequestError("This bot is unavailable; choose another bot.");
      const authority = effectiveRemoteAuthority(await loadRemoteAuthority(tx, liveGrant, bot.id));
      if (!authority.includes(input.replyToTaskId ? "steer" : "dispatch"))
        throw new DeviceRequestError("This device is not allowed to send this request.");
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${bot.thread.id} FOR UPDATE`;
      if (
        (await tx.run.count({
          where: { originDeviceGrantId: grant.id, status: { in: ACTIVE } },
        })) >= 20
      )
        throw new DeviceRequestError("Wait for a task to finish before sending another.", 429);
      let taskId: string;
      let runId: string;
      let status = "queued";
      if (input.replyToTaskId) {
        const active = await tx.run.findFirst({
          where: {
            taskId: input.replyToTaskId,
            botId,
            spaceId: grant.spaceId,
            userId: grant.userId,
            threadId: bot.thread.id,
            status: { in: ACTIVE },
            cancelRequestedAt: null,
          },
          orderBy: { createdAt: "desc" },
        });
        if (!active) throw new DeviceRequestError("This task has finished; send a new task.", 409);
        // Steering adds its own grant to the ceiling; it can never widen a local or remote run.
        await tx.run.update({
          where: { id: active.id },
          data: {
            originDeviceGrantId: active.originDeviceGrantId ?? grant.id,
            remoteRootTaskId: active.remoteRootTaskId ?? active.taskId,
            remoteDeviceGrantIds: [...new Set([...(active.remoteDeviceGrantIds ?? []), grant.id])],
          },
        });
        await steerRunInTransaction(tx, {
          run: active,
          text: input.text,
          clientNonce: `dispatch:${grant.id}:${input.clientNonce}`,
        });
        taskId = active.taskId;
        runId = active.id;
        status = active.status;
      } else {
        const message = await createThreadMessageInTransaction(tx, {
          threadId: bot.thread.id,
          role: "user",
          blocks: [{ kind: "text", text: input.text }],
        });
        const task = await tx.task.create({
          data: {
            spaceId: grant.spaceId,
            userId: grant.userId,
            botId,
            threadId: bot.thread.id,
            prompt: input.text,
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: grant.spaceId,
            userId: grant.userId,
            botId,
            threadId: bot.thread.id,
            taskId: task.id,
            trigger: "user",
            status: "queued",
            originDeviceGrantId: grant.id,
            remoteDeviceGrantIds: [grant.id],
            remoteRootTaskId: task.id,
            sourceMessageId: message.id,
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        await appendEventInTransaction(tx, {
          spaceId: grant.spaceId,
          threadId: bot.thread.id,
          botId,
          runId: run.id,
          type: "thread.message.created",
          payload: {
            messageId: message.id,
            role: "user",
            blocks: [{ kind: "text", text: input.text }],
          },
        });
        taskId = task.id;
        runId = run.id;
      }
      const record = await tx.dispatchReceipt.create({
        data: {
          ...key,
          payloadFingerprint,
          taskId,
          runId,
          botId,
          threadId: bot.thread.id,
          steering: Boolean(input.replyToTaskId),
        },
      });
      await auditDevice(tx, "dispatch.accepted", {
        instanceId: grant.instanceId,
        spaceId: grant.spaceId,
        userId: grant.userId,
        grantId: grant.id,
        taskId,
      });
      return receiptView(record, { status });
    }),
  );
}
export async function requestDispatchStop(
  prisma: PrismaClient,
  grant: DeviceGrant,
  taskId: string,
  now = new Date(),
) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, userId: grant.userId, spaceId: grant.spaceId },
  });
  if (
    !task ||
    !effectiveRemoteAuthority(await loadRemoteAuthority(prisma, grant, task.botId)).includes("stop")
  )
    throw new DeviceRequestError("This task is unavailable on this device.");
  await prisma.run.updateMany({
    where: {
      OR: [{ taskId }, { remoteRootTaskId: taskId }],
      spaceId: grant.spaceId,
      userId: grant.userId,
      status: { in: ACTIVE },
      cancelRequestedAt: null,
    },
    data: { cancelRequestedAt: now },
  });
  return { cancelRequested: true as const };
}
/** Only the executor calls this after its active work has unwound. */
export async function confirmDispatchStop(
  prisma: PrismaClient,
  runId: string,
  now = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.run.findUnique({ where: { id: runId } });
    if (!run?.cancelRequestedAt || !ACTIVE.includes(run.status)) return false;
    if (
      await tx.run.count({
        where: { remoteRootTaskId: run.taskId, id: { not: runId }, status: { in: ACTIVE } },
      })
    )
      return false;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId,
      type: "run.cancelled",
      payload: {},
    });
    const stopped = await tx.run.updateMany({
      where: { id: runId, cancelRequestedAt: { not: null }, status: { in: ACTIVE } },
      data: {
        status: "cancelled",
        cancelConfirmedAt: now,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (!stopped.count) throw new Error("This task changed before stop was confirmed.");
    await tx.task.update({ where: { id: run.taskId }, data: { status: "cancelled" } });
    await tx.attempt.updateMany({
      where: { runId, status: "running" },
      data: { status: "cancelled", finishedAt: now },
    });
    await persistDispatchSummary(tx, run, "stopped", null);
    return true;
  });
}
export async function persistDispatchSummary(
  tx: Prisma.TransactionClient,
  run: { taskId: string; originDeviceGrantId?: string | null; remoteRootTaskId?: string | null },
  state: string,
  messageId: string | null,
) {
  if (!run.originDeviceGrantId || run.remoteRootTaskId !== run.taskId) return;
  await tx.dispatchSummary.upsert({
    where: { taskId: run.taskId },
    create: { taskId: run.taskId, deviceGrantId: run.originDeviceGrantId, state, messageId },
    update: {},
  });
}
/** Propagate authority at admission, in the same transaction that makes a delegated run visible. */
export async function inheritedRemoteOrigin(tx: Prisma.TransactionClient, parentRunId: string) {
  const parent = await tx.run.findUnique({
    where: { id: parentRunId },
    select: {
      originDeviceGrantId: true,
      remoteRootTaskId: true,
      remoteDeviceGrantIds: true,
      taskId: true,
    },
  });
  return parent
    ? {
        originDeviceGrantId: parent.originDeviceGrantId,
        remoteRootTaskId: parent.remoteRootTaskId ?? parent.taskId,
        remoteDeviceGrantIds: parent.remoteDeviceGrantIds ?? [],
      }
    : {};
}
export async function evaluateRemoteExecution(
  prisma: PrismaClient,
  run: {
    originDeviceGrantId?: string | null;
    botId: string;
    taskId: string;
    spaceId: string;
    userId: string;
  },
  tool: string,
) {
  if (!run.originDeviceGrantId) return { allowed: true as const };
  const grant = await prisma.deviceGrant.findUnique({ where: { id: run.originDeviceGrantId } });
  if (!grant || grant.spaceId !== run.spaceId || grant.userId !== run.userId)
    return {
      allowed: false as const,
      reason: "This device is no longer allowed to run work.",
      action: "Approve on your Mac" as const,
    };
  const decision = checkRemoteTool({
    tool,
    authority: await loadRemoteAuthority(prisma, grant, run.botId),
    revoked: Boolean(grant.revokedAt),
    lastPresenceAt: grant.lastPresenceAt?.getTime() ?? null,
    now: Date.now(),
  });
  if (!decision.allowed)
    await auditDevice(prisma, "remote.consequential.blocked", {
      instanceId: grant.instanceId,
      spaceId: run.spaceId,
      userId: run.userId,
      grantId: grant.id,
      taskId: run.taskId,
    });
  return decision;
}
