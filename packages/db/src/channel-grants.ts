import { randomBytes } from "node:crypto";
import type { ChatEvent } from "@ardurbot/contracts";
import { CHANNEL_SCOPES, canonicalDispatchJson } from "@ardurbot/contracts";
import type { ChatInstallation, PrismaClient } from "./client.js";
import {
  auditDevice,
  DeviceRequestError,
  deviceDigest,
  PAIRING_TTL_MS,
  pairingFailure,
} from "./device-grants.js";
import { enqueueChat } from "./messaging-routes.js";

export async function startChannelPairing(
  prisma: PrismaClient,
  installationId: string,
  scopes: string[],
  now = new Date(),
) {
  if (scopes.some((scope) => !(CHANNEL_SCOPES as readonly string[]).includes(scope)))
    throw new DeviceRequestError("Change these permissions at home.");
  const code = randomBytes(6).toString("hex").toUpperCase();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  await prisma.channelPairingChallenge.create({
    data: { hash: deviceDigest(code), installationId, scopes, expiresAt },
  });
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function redeemChannelPairing(
  prisma: PrismaClient,
  installation: ChatInstallation,
  event: ChatEvent,
  now = new Date(),
) {
  if (!event.private || event.provider !== installation.provider) throw pairingFailure();
  const result = await prisma.$transaction(async (tx) => {
    const instanceId = installation.instanceId;
    const replay = await tx.chatInbox.findUnique({
      where: {
        installationId_eventId: { installationId: installation.id, eventId: event.eventId },
      },
    });
    if (replay) {
      if (replay.fingerprint !== deviceDigest(canonicalDispatchJson(event)))
        throw new DeviceRequestError("This event changed.", 409);
      return { id: "consumed" };
    }
    // Same row and lock as the P1 short-code exchange: alternating surfaces cannot evade lockout.
    await tx.pairingThrottle.upsert({ where: { instanceId }, create: { instanceId }, update: {} });
    await tx.$queryRaw`SELECT "instanceId" FROM pairing_throttles WHERE "instanceId" = ${instanceId} FOR UPDATE`;
    const throttle = await tx.pairingThrottle.findUniqueOrThrow({ where: { instanceId } });
    if (throttle.lockedUntil && throttle.lockedUntil > now) return null;
    const hash = deviceDigest(event.text.trim().toUpperCase());
    const challenge = await tx.channelPairingChallenge.findFirst({
      where: { hash, installationId: installation.id, usedAt: null, expiresAt: { gt: now } },
    });
    const workspaceMatches =
      event.workspaceId === installation.workspaceId ||
      (event.provider === "discord" && event.workspaceId === "@direct");
    if (!challenge || !workspaceMatches) {
      const attempts = (throttle.lockedUntil ? 0 : throttle.attempts) + 1;
      await tx.pairingThrottle.update({
        where: { instanceId },
        data: {
          attempts,
          lockedUntil: attempts >= 5 ? new Date(now.getTime() + 15 * 60_000) : null,
        },
      });
      await auditDevice(tx, "pairing.failed", { instanceId });
      return null;
    }
    const claimed = await tx.channelPairingChallenge.updateMany({
      where: { hash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return null;
    await tx.pairingThrottle.update({
      where: { instanceId },
      data: { attempts: 0, lockedUntil: null },
    });
    const identity = {
      installationId: installation.id,
      provider: installation.provider,
      workspaceId: installation.workspaceId,
      senderId: event.senderId,
    };
    // Re-pairing creates an independent record and revokes the old authority.
    await tx.deviceGrant.updateMany({
      where: { ...identity, revokedAt: null },
      data: { revokedAt: now },
    });
    const grant = await tx.deviceGrant.create({
      data: {
        ...identity,
        instanceId,
        userId: installation.userId,
        spaceId: installation.spaceId,
        kind: "channel",
        deviceName: `${installation.provider} account`,
        devicePublicKey: "",
        presencePublicKey: "",
        scopes: challenge.scopes,
        defaultBotId: installation.botId,
      },
    });
    await auditDevice(tx, "channel.paired", {
      instanceId,
      userId: grant.userId,
      spaceId: grant.spaceId,
      grantId: grant.id,
    });
    await tx.chatInbox.create({
      data: {
        installationId: installation.id,
        eventId: event.eventId,
        fingerprint: deviceDigest(canonicalDispatchJson(event)),
        event: {},
        consumedAt: now,
      },
    });
    await enqueueChat(tx, {
      key: `reply:${installation.id}:${event.eventId}`,
      installationId: installation.id,
      destination: event,
      card: { text: "Paired." },
    });
    return grant;
  });
  if (!result) throw pairingFailure();
  return result;
}

export async function authenticateChannel(
  prisma: PrismaClient,
  installation: ChatInstallation,
  event: ChatEvent,
) {
  if (!installation.enabled || event.provider !== installation.provider) return null;
  const workspaceId =
    event.provider === "discord" && event.private && event.workspaceId === "@direct"
      ? installation.workspaceId
      : event.workspaceId;
  if (workspaceId !== installation.workspaceId) return null;
  const grant = await prisma.deviceGrant.findFirst({
    where: {
      kind: "channel",
      instanceId: installation.instanceId,
      installationId: installation.id,
      provider: event.provider,
      workspaceId,
      senderId: event.senderId,
      revokedAt: null,
      userId: installation.userId,
      spaceId: installation.spaceId,
    },
  });
  if (
    !grant ||
    !(await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: grant.spaceId, userId: grant.userId } },
    }))
  )
    return null;
  await prisma.deviceGrant.updateMany({
    where: { id: grant.id, revokedAt: null },
    data: { lastUsedAt: new Date() },
  });
  return grant;
}
