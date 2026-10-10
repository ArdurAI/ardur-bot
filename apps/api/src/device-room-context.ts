import type { Actor, DeviceScope } from "@ardurbot/contracts";
import { canonicalDispatchJson } from "@ardurbot/contracts";
import { ACTIVE_RUN_STATUSES, effectiveRemoteAuthority } from "@ardurbot/core";
import type { DeviceGrant, Prisma } from "@ardurbot/db";
import {
  assertDeviceTrusted,
  DeviceRequestError,
  deviceDigest,
  loadRemoteAuthority,
  readChiefReceipt,
  requireDispatchEnabled,
} from "@ardurbot/db";

const UNAVAILABLE = "This action is unavailable from this device.";

/** Created only after signed device authentication; reverified at admission and replay. */
export class DeviceRoomContext {
  constructor(readonly grant: DeviceGrant) {}

  async verify(tx: Prisma.TransactionClient, actor: Actor) {
    await tx.$queryRaw`SELECT id FROM device_grants WHERE id = ${this.grant.id} FOR UPDATE`;
    const live = await tx.deviceGrant.findFirst({
      where: {
        id: this.grant.id,
        instanceId: this.grant.instanceId,
        userId: actor.userId,
        spaceId: actor.spaceId,
        revokedAt: null,
        kind: "device",
      },
    });
    const owner = await tx.deploymentSettings.findUnique({ where: { id: "default" } });
    const member = await tx.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    });
    if (
      !live ||
      !member ||
      owner?.ownerUserId !== actor.userId ||
      actor.userId !== this.grant.userId ||
      actor.spaceId !== this.grant.spaceId ||
      !live.scopes.includes("dispatch") ||
      !live.scopes.includes("ordinary")
    )
      throw new DeviceRequestError(UNAVAILABLE);
    await assertDeviceTrusted(tx, live);
    await requireDispatchEnabled(tx, actor.spaceId);
    return live;
  }

  async authority(
    tx: Prisma.TransactionClient,
    live: DeviceGrant,
    botId: string,
    steering = false,
  ) {
    const scopes = effectiveRemoteAuthority(await loadRemoteAuthority(tx, live, botId));
    const required: DeviceScope[] = [
      "dispatch",
      "ordinary",
      ...(steering ? ["steer" as const] : []),
    ];
    if (!required.every((scope) => scopes.includes(scope)))
      throw new DeviceRequestError(UNAVAILABLE);
  }

  async replay(
    tx: Prisma.TransactionClient,
    live: DeviceGrant,
    threadId: string,
    nonce: string,
    text: string,
  ) {
    const message = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId, clientNonce: nonce } },
    });
    if (!message) return;
    const event = await tx.event.findFirst({
      where: {
        threadId,
        type: "thread.message.created",
        payload: { path: ["messageId"], equals: message.id },
      },
      select: { payload: true },
    });
    const payload = event?.payload;
    if (
      message.actorId !== live.userId ||
      canonicalDispatchJson(message.blocks) !==
        canonicalDispatchJson([{ kind: "text", text: text.trim() }]) ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      payload.deviceRequestFingerprint !== deviceDigest(canonicalDispatchJson({ text }))
    )
      throw new DeviceRequestError("This request changed; send it as a new task.", 409);
    const receipts = await tx.dispatchReceipt.findMany({
      where: {
        instanceId: live.instanceId,
        spaceId: live.spaceId,
        deviceGrantId: live.id,
        threadId,
        clientNonce: { startsWith: `${nonce}:` },
      },
    });
    for (const receipt of receipts) await this.authority(tx, live, receipt.botId, receipt.steering);
    const chiefReceipt = await readChiefReceipt(tx, threadId, message.id);
    if (chiefReceipt) await this.authority(tx, live, chiefReceipt.botId);
  }

  async bindRun(
    tx: Prisma.TransactionClient,
    live: DeviceGrant,
    run: { id: string; taskId: string; botId: string },
    nonce: string,
    text: string,
    threadId: string,
    steering: boolean,
  ) {
    await this.authority(tx, live, run.botId, steering);
    const current = await tx.run.findFirst({
      where: { id: run.id, botId: run.botId, threadId, userId: live.userId, spaceId: live.spaceId },
    });
    if (!current) throw new DeviceRequestError(UNAVAILABLE);
    if (
      current.originDeviceGrantId !== live.id &&
      !current.remoteDeviceGrantIds.includes(live.id) &&
      (await tx.run.count({
        where: {
          status: { in: [...ACTIVE_RUN_STATUSES] },
          OR: [{ originDeviceGrantId: live.id }, { remoteDeviceGrantIds: { has: live.id } }],
        },
      })) >= 20
    )
      throw new DeviceRequestError("Wait for a task to finish before sending another.", 429);
    await tx.run.update({
      where: { id: run.id },
      data: {
        originDeviceGrantId: current.originDeviceGrantId ?? live.id,
        remoteRootTaskId: current.remoteRootTaskId ?? current.taskId,
        remoteDeviceGrantIds: [...new Set([...current.remoteDeviceGrantIds, live.id])],
      },
    });
    await tx.dispatchReceipt.create({
      data: {
        instanceId: live.instanceId,
        spaceId: live.spaceId,
        deviceGrantId: live.id,
        clientNonce: `${nonce}:${run.id}`,
        payloadFingerprint: deviceDigest(canonicalDispatchJson({ text })),
        taskId: run.taskId,
        runId: run.id,
        botId: run.botId,
        threadId,
        steering,
      },
    });
  }
}
