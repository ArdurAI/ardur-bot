import type { ChatEvent } from "@ardurbot/contracts";
import { CHANNEL_SCOPES } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  authenticateChannel,
  redeemChannelPairing,
  startChannelPairing,
} from "./channel-grants.js";
import type { ChatInstallation, DeviceGrant, PrismaClient } from "./client.js";
import { deviceDigest } from "./device-grants.js";

const installation = {
  id: "installation",
  instanceId: "home",
  provider: "slack",
  workspaceId: "team",
  userId: "owner",
  spaceId: "space",
  botId: "bot",
  enabled: true,
} as ChatInstallation;
const event: ChatEvent = {
  provider: "slack",
  workspaceId: "team",
  senderId: "sender",
  channelId: "Dprivate",
  messageId: "message",
  eventId: "event",
  private: true,
  text: "ABCDEF123456",
  attachmentBytes: 0,
  attachmentCount: 0,
};
function fixture() {
  const challenges: Array<{
    hash: string;
    scopes: string[];
    installationId: string;
    expiresAt: Date;
    usedAt?: Date;
  }> = [];
  const throttle = { attempts: 0, lockedUntil: null as Date | null };
  const grant = {
    ...installation,
    id: "grant",
    installationId: installation.id,
    kind: "channel",
    senderId: "sender",
    revokedAt: null,
    scopes: CHANNEL_SCOPES,
  } as unknown as DeviceGrant;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    pairingThrottle: {
      upsert: vi.fn(),
      findUniqueOrThrow: vi.fn(async () => throttle),
      update: vi.fn(async ({ data }) => Object.assign(throttle, data)),
    },
    channelPairingChallenge: {
      create: vi.fn(async ({ data }) => {
        challenges.push(data);
        return data;
      }),
      findFirst: vi.fn(
        async ({ where }) =>
          challenges.find(
            (c) =>
              c.hash === where.hash &&
              c.installationId === where.installationId &&
              !c.usedAt &&
              c.expiresAt > where.expiresAt.gt,
          ) ?? null,
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = challenges.find((c) => c.hash === where.hash && !c.usedAt);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    deviceGrant: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async ({ data }) => ({ ...grant, ...data })),
      findFirst: vi.fn(async () => grant),
    },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member" })) },
    chatInbox: { findUnique: vi.fn(async () => null), create: vi.fn() },
    chatOutbox: {
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      upsert: vi.fn(),
    },
    deviceAuditEvent: { create: vi.fn() },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  return { db, tx, throttle, challenges };
}
describe("paired channel grants", () => {
  it("hashes a five-minute single-use code and binds the immutable identity", async () => {
    const f = fixture();
    const now = new Date();
    const issued = await startChannelPairing(f.db, installation.id, [...CHANNEL_SCOPES], now);
    expect(f.challenges[0]?.hash).toBe(deviceDigest(issued.code));
    expect(new Date(issued.expiresAt).getTime() - now.getTime()).toBe(300_000);
    const message = { ...event, text: issued.code };
    await redeemChannelPairing(f.db, installation, message, now);
    expect(f.tx.deviceGrant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "channel",
        installationId: "installation",
        provider: "slack",
        workspaceId: "team",
        senderId: "sender",
        scopes: CHANNEL_SCOPES,
        devicePublicKey: "",
      }),
    });
    expect(f.tx.chatInbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: {}, consumedAt: now }),
    });
    expect(JSON.stringify(f.tx.chatOutbox.upsert.mock.calls)).not.toContain(issued.code);
    await expect(
      redeemChannelPairing(f.db, installation, { ...message, eventId: "second" }, now),
    ).rejects.toThrow("unavailable");
    expect(f.tx.deviceGrant.create).toHaveBeenCalledOnce();
  });
  it("rejects expired codes, group exchanges and another workspace", async () => {
    const f = fixture();
    const issued = await startChannelPairing(f.db, installation.id, ["dispatch"], new Date(0));
    await expect(
      redeemChannelPairing(f.db, installation, { ...event, text: issued.code }, new Date(300_001)),
    ).rejects.toThrow();
    await expect(
      redeemChannelPairing(f.db, installation, { ...event, private: false }),
    ).rejects.toThrow();
    const current = await startChannelPairing(f.db, installation.id, ["dispatch"]);
    await expect(
      redeemChannelPairing(f.db, installation, {
        ...event,
        text: current.code,
        workspaceId: "another-team",
      }),
    ).rejects.toThrow();
    expect(f.tx.deviceGrant.create).not.toHaveBeenCalled();
  });
  it("shares P1's home throttle and locks after five failed attempts", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++)
      await expect(redeemChannelPairing(f.db, installation, event)).rejects.toThrow();
    expect(f.throttle.attempts).toBe(5);
    expect(f.throttle.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const issued = await startChannelPairing(f.db, installation.id, ["dispatch"]);
    await expect(
      redeemChannelPairing(f.db, installation, { ...event, text: issued.code }),
    ).rejects.toThrow();
    expect(f.tx.deviceGrant.create).not.toHaveBeenCalled();
  });
  it("isolates a paired sender by installation, provider and workspace", async () => {
    const f = fixture();
    expect(
      await authenticateChannel(f.db, installation, { ...event, workspaceId: "another-team" }),
    ).toBeNull();
    expect(f.tx.deviceGrant.findFirst).not.toHaveBeenCalled();
    await authenticateChannel(f.db, installation, event);
    expect(f.tx.deviceGrant.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        installationId: "installation",
        provider: "slack",
        workspaceId: "team",
        senderId: "sender",
        revokedAt: null,
      }),
    });
    f.tx.spaceMember.findUnique.mockResolvedValueOnce(null as never);
    expect(await authenticateChannel(f.db, installation, event)).toBeNull();
  });
  it("cannot pair a grant with consequential scope", async () => {
    const f = fixture();
    await expect(startChannelPairing(f.db, installation.id, ["consequential"])).rejects.toThrow();
    expect(f.tx.channelPairingChallenge.create).not.toHaveBeenCalled();
  });
});
