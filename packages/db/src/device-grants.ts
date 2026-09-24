import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import type { DeviceProof, DeviceScope } from "@ardurbot/contracts";
import { deviceSignedText, pairingSignedText } from "@ardurbot/contracts";
import type { DeviceGrant, Prisma, PrismaClient } from "./client.js";

export const PAIRING_TTL_MS = 5 * 60_000;
export const REQUEST_TTL_MS = 60_000;
export class DeviceRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 409 | 429 = 403,
  ) {
    super(message);
  }
}
export const pairingFailure = () =>
  new DeviceRequestError("This pairing code is unavailable; start pairing again at home.", 401);
export const deviceDigest = (text: string) => createHash("sha256").update(text).digest("hex");
export function verifyDeviceSignature(publicKey: string, text: string, signature: string): boolean {
  try {
    if (publicKey.length > 256 || signature.length > 256) return false;
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return (
      key.asymmetricKeyType === "ec" &&
      key.asymmetricKeyDetails?.namedCurve === "prime256v1" &&
      verify("sha256", Buffer.from(text), key, Buffer.from(signature, "base64"))
    );
  } catch {
    return false;
  }
}
export type DeviceAuditType =
  | "channel.paired"
  | "channel.revoked"
  | "approval.channel.answered"
  | "pairing.started"
  | "pairing.completed"
  | "pairing.failed"
  | "device.revoked"
  | "device.approved"
  | "dispatch.accepted"
  | "approval.device.answered"
  | "remote.consequential.blocked";
export function auditDevice(
  tx: Pick<Prisma.TransactionClient, "deviceAuditEvent">,
  type: DeviceAuditType,
  fields: {
    instanceId: string;
    userId?: string;
    spaceId?: string;
    grantId?: string;
    taskId?: string;
    effectId?: string;
  },
) {
  // An explicit metadata shape prevents names, hints, arguments and key material reaching audit logs.
  return tx.deviceAuditEvent.create({ data: { type, ...fields } });
}
export async function startDevicePairing(
  prisma: PrismaClient,
  input: {
    instanceId: string;
    userId: string;
    spaceId: string;
    scopes: DeviceScope[];
  },
  now = new Date(),
) {
  const challenge = randomBytes(32).toString("base64url");
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const shortCode = Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  await prisma.$transaction(async (tx) => {
    await tx.pairingChallenge.create({
      data: {
        ...input,
        hash: deviceDigest(challenge),
        shortCodeHash: deviceDigest(shortCode),
        expiresAt,
      },
    });
    await auditDevice(tx, "pairing.started", {
      instanceId: input.instanceId,
      userId: input.userId,
      spaceId: input.spaceId,
    });
  });
  return { challenge, shortCode, expiresAt };
}
export interface PairDeviceInput {
  platform?: string;
  challenge: string;
  instanceId: string;
  deviceName: string;
  devicePublicKey: string;
  presencePublicKey: string;
  signature: string;
}
function validPairSignature(input: PairDeviceInput) {
  return (
    input.devicePublicKey !== input.presencePublicKey &&
    verifyDeviceSignature(
      input.devicePublicKey,
      pairingSignedText(
        input.challenge,
        input.instanceId,
        input.devicePublicKey,
        input.presencePublicKey,
      ),
      input.signature,
    )
  );
}
function grantData(
  challenge: { userId: string; spaceId: string; instanceId: string; scopes: string[] },
  input: PairDeviceInput,
) {
  return {
    userId: challenge.userId,
    spaceId: challenge.spaceId,
    instanceId: challenge.instanceId,
    scopes: challenge.scopes,
    deviceName: input.deviceName,
    platform: input.platform,
    devicePublicKey: input.devicePublicKey,
    presencePublicKey: input.presencePublicKey,
  };
}
export async function completeDevicePairing(
  prisma: PrismaClient,
  instanceId: string,
  input: PairDeviceInput,
  now = new Date(),
) {
  let grant: DeviceGrant | null = null;
  if (input.instanceId === instanceId && validPairSignature(input)) {
    grant = await prisma.$transaction(async (tx) => {
      const hash = deviceDigest(input.challenge);
      const claimed = await tx.pairingChallenge.updateMany({
        where: { hash, instanceId, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return null;
      const challenge = await tx.pairingChallenge.findUniqueOrThrow({ where: { hash } });
      // Serialize pairing with policy changes so a newly paired device cannot slip past trust.
      await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${challenge.spaceId} FOR UPDATE`;
      const space = await tx.space.findUniqueOrThrow({ where: { id: challenge.spaceId } });
      const created = await tx.deviceGrant.create({
        data: {
          ...grantData(challenge, input),
          trustedAt: space.requireTrustedDevices ? null : now,
        },
      });
      await auditDevice(tx, "pairing.completed", {
        instanceId,
        userId: created.userId,
        spaceId: created.spaceId,
        grantId: created.id,
      });
      return created;
    });
  }
  if (!grant) {
    await auditDevice(prisma, "pairing.failed", { instanceId });
    throw pairingFailure();
  }
  return grant;
}
export async function requestShortCodePairing(
  prisma: PrismaClient,
  instanceId: string,
  input: PairDeviceInput,
  now = new Date(),
) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.pairingThrottle.upsert({ where: { instanceId }, create: { instanceId }, update: {} });
    await tx.$queryRaw`SELECT "instanceId" FROM pairing_throttles WHERE "instanceId" = ${instanceId} FOR UPDATE`;
    const throttle = await tx.pairingThrottle.findUniqueOrThrow({ where: { instanceId } });
    if (throttle.lockedUntil && throttle.lockedUntil > now) return "locked" as const;
    const shortCodeHash = deviceDigest(input.challenge.toUpperCase());
    const challenge = await tx.pairingChallenge.findFirst({
      where: { shortCodeHash, instanceId, usedAt: null, expiresAt: { gt: now } },
    });
    if (!challenge || input.instanceId !== instanceId || !validPairSignature(input)) {
      const attempts = (throttle.lockedUntil ? 0 : throttle.attempts) + 1;
      await tx.pairingThrottle.update({
        where: { instanceId },
        data: {
          attempts,
          lockedUntil: attempts >= 5 ? new Date(now.getTime() + 15 * 60_000) : null,
        },
      });
      await auditDevice(tx, "pairing.failed", { instanceId });
      return attempts >= 5 ? ("locked" as const) : null;
    }
    const claimed = await tx.pairingChallenge.updateMany({
      where: { hash: challenge.hash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return null;
    await tx.pairingThrottle.update({
      where: { instanceId },
      data: { attempts: 0, lockedUntil: null },
    });
    return tx.pendingDevicePairing.create({
      data: {
        ...grantData(challenge, input),
        challengeHash: challenge.hash,
        expiresAt: challenge.expiresAt,
      },
    });
  });
  if (result === "locked")
    throw new DeviceRequestError("Pairing is locked for 15 minutes; try again later.", 429);
  if (!result) throw pairingFailure();
  return { pendingId: result.id };
}
export async function confirmShortCodePairing(
  prisma: PrismaClient,
  actor: { userId: string; spaceId: string },
  id: string,
  allow: boolean,
  now = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM pending_device_pairings WHERE id = ${id} FOR UPDATE`;
    const pending = await tx.pendingDevicePairing.findFirst({
      where: { id, ...actor, grantId: null, deniedAt: null, expiresAt: { gt: now } },
    });
    if (!pending) throw pairingFailure();
    if (!allow) {
      await tx.pendingDevicePairing.update({ where: { id }, data: { deniedAt: now } });
      return;
    }
    const grant = await tx.deviceGrant.create({
      data: {
        userId: pending.userId,
        spaceId: pending.spaceId,
        instanceId: pending.instanceId,
        scopes: pending.scopes,
        deviceName: pending.deviceName,
        platform: pending.platform,
        devicePublicKey: pending.devicePublicKey,
        presencePublicKey: pending.presencePublicKey,
        trustedAt: now,
      },
    });
    await tx.pendingDevicePairing.update({ where: { id }, data: { grantId: grant.id } });
    await auditDevice(tx, "pairing.completed", {
      instanceId: grant.instanceId,
      userId: grant.userId,
      spaceId: grant.spaceId,
      grantId: grant.id,
    });
  });
}
export async function issueDeviceNonce(
  prisma: PrismaClient,
  instanceId: string,
  grantId: string,
  purpose: "request" | "presence",
  now = new Date(),
) {
  const grant = await prisma.deviceGrant.findFirst({
    where: { id: grantId, instanceId, revokedAt: null },
  });
  if (!grant || grant.kind === "channel")
    throw new DeviceRequestError("This device is unavailable; pair it again at home.", 401);
  // Bound outstanding challenges per grant and prune used/expired rows on admission.
  await prisma.deviceNonce.deleteMany({
    where: { OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }] },
  });
  if ((await prisma.deviceNonce.count({ where: { grantId } })) >= 16)
    throw new DeviceRequestError("Wait a moment before trying again.", 429);
  const nonce = randomBytes(32).toString("base64url");
  await prisma.deviceNonce.create({
    data: {
      hash: deviceDigest(nonce),
      grantId,
      purpose,
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    },
  });
  return { nonce, timestamp: now.getTime() };
}
export async function authenticateDevice(
  prisma: PrismaClient,
  instanceId: string,
  proof: DeviceProof,
  operation: string,
  body: unknown,
  now = new Date(),
): Promise<DeviceGrant> {
  const failure = () =>
    new DeviceRequestError("This request is unavailable; reconnect your device.", 401);
  return prisma.$transaction(async (tx) => {
    const grant = await tx.deviceGrant.findFirst({
      where: { id: proof.grantId, instanceId, revokedAt: null },
    });
    const presence = operation === "presence";
    if (
      !grant ||
      grant.kind === "channel" ||
      Math.abs(now.getTime() - proof.timestamp) > REQUEST_TTL_MS ||
      !verifyDeviceSignature(
        presence ? grant.presencePublicKey : grant.devicePublicKey,
        deviceSignedText(instanceId, proof, operation, body),
        proof.signature,
      )
    )
      throw failure();
    const used = await tx.deviceNonce.updateMany({
      where: {
        hash: deviceDigest(proof.nonce),
        grantId: grant.id,
        purpose: presence ? "presence" : "request",
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (used.count !== 1) throw failure();
    if (["dispatch", "answer", "default", "team-accept"].includes(operation))
      await assertDeviceTrusted(tx, grant);
    const member = await tx.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: grant.spaceId, userId: grant.userId } },
    });
    if (!member) throw failure();
    const touched = await tx.deviceGrant.updateMany({
      where: { id: grant.id, revokedAt: null },
      data: { lastUsedAt: now, ...(presence ? { lastPresenceAt: new Date(proof.timestamp) } : {}) },
    });
    if (touched.count !== 1) throw failure();
    return grant;
  });
}

/** Also called at transactional dispatch admission, where a grant may have changed. */
export async function assertDeviceTrusted(
  prisma: Pick<Prisma.TransactionClient, "space">,
  grant: Pick<DeviceGrant, "kind" | "trustedAt" | "spaceId">,
) {
  if (grant.kind === "channel" || grant.trustedAt !== null) return;
  const space = await prisma.space.findUniqueOrThrow({ where: { id: grant.spaceId } });
  if (space.requireTrustedDevices)
    throw new DeviceRequestError("Ask the owner to approve this device in Account settings.");
}
