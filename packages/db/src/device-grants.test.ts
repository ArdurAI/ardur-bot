import { generateKeyPairSync, sign } from "node:crypto";
import { deviceSignedText, pairingSignedText } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  authenticateDevice,
  completeDevicePairing,
  confirmShortCodePairing,
  deviceDigest,
  requestShortCodePairing,
  startDevicePairing,
} from "./device-grants.js";

const now = new Date("2026-01-01T00:00:00Z");
function keys() {
  const k = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { ...k, public: k.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}
function fixture() {
  const device = keys();
  const presence = keys();
  const challenge = {
    hash: deviceDigest("challenge"),
    shortCodeHash: deviceDigest("ABCDEFGH"),
    instanceId: "home",
    userId: "owner",
    spaceId: "space",
    scopes: ["read", "dispatch"],
    expiresAt: new Date(now.getTime() + 300_000),
    usedAt: null as Date | null,
  };
  const grant = {
    id: "phone",
    ...challenge,
    devicePublicKey: device.public,
    presencePublicKey: presence.public,
    revokedAt: null as Date | null,
  };
  const throttle = { instanceId: "home", attempts: 0, lockedUntil: null as Date | null };
  let nonceUsed = false;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    pairingChallenge: {
      create: vi.fn(async ({ data }) => data),
      findUniqueOrThrow: vi.fn(async () => challenge),
      findFirst: vi.fn(async ({ where }) =>
        where.shortCodeHash === challenge.shortCodeHash &&
        !challenge.usedAt &&
        challenge.expiresAt > now
          ? challenge
          : null,
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          where.hash !== challenge.hash ||
          challenge.usedAt ||
          challenge.expiresAt <= where.expiresAt.gt
        )
          return { count: 0 };
        challenge.usedAt = data.usedAt;
        return { count: 1 };
      }),
    },
    pairingThrottle: {
      upsert: vi.fn(async () => throttle),
      findUniqueOrThrow: vi.fn(async () => throttle),
      update: vi.fn(async ({ data }) => Object.assign(throttle, data)),
    },
    pendingDevicePairing: { create: vi.fn(async ({ data }) => ({ ...data, id: "pending" })) },
    deviceGrant: {
      create: vi.fn(async () => grant),
      findFirst: vi.fn(async () => (grant.revokedAt ? null : grant)),
      updateMany: vi.fn(async () => ({ count: grant.revokedAt ? 0 : 1 })),
    },
    deviceAuditEvent: { create: vi.fn(async ({ data }) => data) },
    deviceNonce: {
      updateMany: vi.fn(async () => {
        if (nonceUsed) return { count: 0 };
        nonceUsed = true;
        return { count: 1 };
      }),
    },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "membership" })) },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  const input = (value = "challenge", instanceId = "home") => ({
    challenge: value,
    instanceId,
    deviceName: "Test phone",
    devicePublicKey: device.public,
    presencePublicKey: presence.public,
    signature: sign(
      "sha256",
      Buffer.from(pairingSignedText(value, instanceId, device.public, presence.public)),
      device.privateKey,
    ).toString("base64"),
  });
  return { tx, db, device, presence, challenge, grant, throttle, input };
}
describe("device grants", () => {
  it("stores only challenge hashes and a five-minute expiry", async () => {
    const f = fixture();
    const result = await startDevicePairing(
      f.db,
      { instanceId: "home", userId: "owner", spaceId: "space", scopes: ["read"] },
      now,
    );
    const data = f.tx.pairingChallenge.create.mock.calls[0]![0].data;
    expect(data.hash).toBe(deviceDigest(result.challenge));
    expect(data.challenge).toBeUndefined();
    expect(result.shortCode).toHaveLength(8);
    expect(result.expiresAt.getTime() - now.getTime()).toBe(300_000);
  });
  it("lets only one concurrent redemption win", async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      completeDevicePairing(f.db, "home", f.input(), now),
      completeDevicePairing(f.db, "home", f.input(), now),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.tx.deviceGrant.create).toHaveBeenCalledOnce();
  });
  it("rejects an expired or wrong-instance challenge and a swapped presence key", async () => {
    const f = fixture();
    await expect(completeDevicePairing(f.db, "other", f.input(), now)).rejects.toThrow(
      "pairing code",
    );
    await expect(
      completeDevicePairing(f.db, "home", { ...f.input(), presencePublicKey: keys().public }, now),
    ).rejects.toThrow("pairing code");
    await expect(
      completeDevicePairing(f.db, "home", f.input(), f.challenge.expiresAt),
    ).rejects.toThrow("pairing code");
    expect(f.tx.deviceGrant.create).not.toHaveBeenCalled();
  });
  it("locks the short-code fallback for 15 minutes after five failures", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++)
      await expect(
        requestShortCodePairing(f.db, "home", f.input("WRONG123"), now),
      ).rejects.toThrow();
    expect(f.throttle.lockedUntil?.getTime()).toBe(now.getTime() + 900_000);
    await expect(requestShortCodePairing(f.db, "home", f.input("ABCDEFGH"), now)).rejects.toThrow(
      "15 minutes",
    );
    expect(f.tx.deviceGrant.create).not.toHaveBeenCalled();
  });
  it("makes a correct code pending without issuing a grant", async () => {
    const f = fixture();
    expect(await requestShortCodePairing(f.db, "home", f.input("ABCDEFGH"), now)).toEqual({
      pendingId: "pending",
    });
    expect(f.tx.deviceGrant.create).not.toHaveBeenCalled();
  });
  it("rejects replay, changed body, stale timestamps and revocation on the next signed request", async () => {
    const f = fixture();
    const p = { grantId: "phone", nonce: "n".repeat(43), timestamp: now.getTime() };
    const proof = {
      ...p,
      signature: sign(
        "sha256",
        Buffer.from(deviceSignedText("home", p, "rpc", { procedure: "me" })),
        f.device.privateKey,
      ).toString("base64"),
    };
    await expect(
      authenticateDevice(f.db, "home", proof, "rpc", { procedure: "write" }, now),
    ).rejects.toThrow();
    await expect(
      authenticateDevice(
        f.db,
        "home",
        proof,
        "rpc",
        { procedure: "me" },
        new Date(now.getTime() + 61_000),
      ),
    ).rejects.toThrow();
    await expect(
      authenticateDevice(f.db, "home", proof, "rpc", { procedure: "me" }, now),
    ).resolves.toMatchObject({ id: "phone" });
    await expect(
      authenticateDevice(f.db, "home", proof, "rpc", { procedure: "me" }, now),
    ).rejects.toThrow();
    f.grant.revokedAt = now;
    await expect(
      authenticateDevice(f.db, "home", proof, "rpc", { procedure: "me" }, now),
    ).rejects.toThrow();
  });
  it("requires the presence key for a presence proof", async () => {
    const f = fixture();
    const p = { grantId: "phone", nonce: "n".repeat(43), timestamp: now.getTime() };
    const signature = sign(
      "sha256",
      Buffer.from(deviceSignedText("home", p, "presence", {})),
      f.device.privateKey,
    ).toString("base64");
    await expect(
      authenticateDevice(f.db, "home", { ...p, signature }, "presence", {}, now),
    ).rejects.toThrow();
    const signedPresence = sign(
      "sha256",
      Buffer.from(deviceSignedText("home", p, "presence", {})),
      f.presence.privateKey,
    ).toString("base64");
    await authenticateDevice(
      f.db,
      "home",
      { ...p, signature: signedPresence },
      "presence",
      {},
      now,
    );
    expect(f.tx.deviceGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastPresenceAt: now }) }),
    );
  });
});

it("requires home confirmation before issuing a short-code grant", async () => {
  const f = fixture();
  const pending = {
    ...f.grant,
    id: "pending",
    grantId: null as string | null,
    deniedAt: null as Date | null,
  };
  const db = {
    ...f.tx,
    pendingDevicePairing: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        where.userId === "owner" && !pending.grantId ? pending : null,
      ),
      update: vi.fn(async ({ data }) => Object.assign(pending, data)),
    },
  };
  const prisma = {
    ...db,
    $transaction: async (fn: (tx: typeof db) => unknown) => fn(db),
  } as unknown as PrismaClient;
  await expect(
    confirmShortCodePairing(prisma, { userId: "other", spaceId: "space" }, "pending", true, now),
  ).rejects.toThrow();
  expect(f.tx.deviceGrant.create).not.toHaveBeenCalled();
  await confirmShortCodePairing(
    prisma,
    { userId: "owner", spaceId: "space" },
    "pending",
    true,
    now,
  );
  expect(f.tx.deviceGrant.create).toHaveBeenCalledOnce();
  await expect(
    confirmShortCodePairing(prisma, { userId: "owner", spaceId: "space" }, "pending", true, now),
  ).rejects.toThrow();
});
