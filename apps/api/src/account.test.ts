import type { Auth } from "@ardurbot/auth";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { assertDeviceTrusted } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { createAccountService } from "./account.js";
import type { createRemoteDevices } from "./remote-devices.js";

function fixture() {
  const actor: Actor = {
    userId: "owner",
    spaceId: "space",
    email: "operator@example.test",
    isDeploymentOwner: true,
  };
  const space = {
    botInstructions: "",
    botInstructionsRevision: 0,
    botInstructionsAuthorId: null as string | null,
    requireTrustedDevices: false,
  };
  const grant = {
    id: "phone",
    kind: "device",
    instanceId: "home",
    userId: "owner",
    spaceId: "space",
    trustedAt: null as Date | null,
    deviceName: "Test phone",
    platform: "ios",
    createdAt: new Date("2026-09-24T05:00:00Z"),
    lastUsedAt: null,
    revokedAt: null,
  };
  const host = {
    id: "default",
    generation: "generation",
    tokenHash: "88c4c7666e266dc304941faed55a473c5103f9226538773a685b514f62e997e6",
    userId: "owner",
    name: "Test computer",
    platform: "linux",
    createdAt: grant.createdAt,
    lastSeenAt: grant.createdAt,
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    user: {
      findUniqueOrThrow: vi.fn(async () => ({
        name: "Test operator",
        displayName: "Captain",
        workType: "research",
        avatarStyle: "robot",
      })),
      update: vi.fn(async ({ data }) => data),
    },
    space: {
      findUniqueOrThrow: vi.fn(async () => space),
      update: vi.fn(async ({ data }) => Object.assign(space, data)),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          where.id !== actor.spaceId ||
          where.botInstructionsRevision !== space.botInstructionsRevision
        )
          return { count: 0 };
        space.botInstructions = data.botInstructions;
        space.botInstructionsAuthorId = data.botInstructionsAuthorId;
        space.botInstructionsRevision++;
        return { count: 1 };
      }),
    },
    spaceMember: { findUnique: vi.fn(async () => ({ role: "owner" })) },
    hostRegistration: {
      findFirst: vi.fn(async () => host as typeof host | null),
      findMany: vi.fn(async () => [host]),
    },
    deviceGrant: {
      findMany: vi.fn(async () => [grant]),
      findFirst: vi.fn(async ({ where }) =>
        where.id === grant.id &&
        where.userId === grant.userId &&
        where.spaceId === grant.spaceId &&
        !grant.revokedAt
          ? grant
          : null,
      ),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(grant, data);
        return { count: 1 };
      }),
    },
    deviceAuditEvent: { create: vi.fn(async ({ data }) => data) },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  const revoke = vi.fn(async () => ({ ok: true as const }));
  const service = createAccountService({
    prisma,
    auth: {} as Auth,
    remoteDevices: { revoke } as unknown as ReturnType<typeof createRemoteDevices>,
  });
  return { actor, space, grant, tx, prisma, service, revoke };
}
describe("account service", () => {
  it("scopes profile writes and records human provenance with optimistic revision checks", async () => {
    const f = fixture();
    await f.service.updateProfile(f.actor, {
      name: " Test operator ",
      displayName: " Captain ",
      workType: "research",
      avatarStyle: "organic",
    });
    expect(f.tx.user.update).toHaveBeenCalledWith({
      where: { id: "owner" },
      data: {
        name: "Test operator",
        displayName: "Captain",
        workType: "research",
        avatarStyle: "organic",
      },
    });
    expect(
      await f.service.updateInstructions(f.actor, {
        instructions: "Use concise answers.",
        revision: 0,
      }),
    ).toEqual({ revision: 1 });
    expect(f.space).toMatchObject({ botInstructionsAuthorId: "owner", botInstructionsRevision: 1 });
    await expect(
      f.service.updateInstructions(f.actor, { instructions: "stale edit", revision: 0 }),
    ).rejects.toThrow("Instructions changed");
    await expect(
      f.service.updateInstructions(f.actor, { instructions: "x".repeat(4001), revision: 1 }),
    ).rejects.toThrow();
  });
  it("allows shared instructions only for a space owner or admin", async () => {
    const f = fixture();
    f.tx.spaceMember.findUnique.mockResolvedValue({ role: "member" });
    expect((await f.service.get(f.actor)).canEditInstructions).toBe(false);
    await expect(
      f.service.updateInstructions(f.actor, { instructions: "change", revision: 0 }),
    ).rejects.toThrow();
    expect(f.tx.space.updateMany).not.toHaveBeenCalled();
  });
  it("refuses to enable trust without a desktop, then blocks until the owner approves", async () => {
    const f = fixture();
    f.tx.hostRegistration.findFirst.mockResolvedValueOnce(null);
    await expect(f.service.setTrustedDevices(f.actor, true)).rejects.toThrow(
      "Connect a desktop app",
    );
    expect(f.space.requireTrustedDevices).toBe(false);
    await f.service.setTrustedDevices(f.actor, true);
    await expect(assertDeviceTrusted(f.prisma, f.grant)).rejects.toThrow("approve this device");
    await expect(
      f.service.approveDevice({ ...f.actor, isDeploymentOwner: false }, "phone"),
    ).rejects.toThrow();
    await expect(
      f.service.approveDevice({ ...f.actor, spaceId: "another-space" }, "phone"),
    ).rejects.toThrow();
    await f.service.approveDevice(f.actor, "phone");
    await expect(assertDeviceTrusted(f.prisma, f.grant)).resolves.toBeUndefined();
    expect(f.tx.deviceAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "device.approved", grantId: "phone" }),
    });
  });
  it("projects host heartbeat and paired activity without roots or credentials", async () => {
    const f = fixture();
    const rows = await f.service.localDevices(f.actor);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "host",
        registrationId: "abec6392afbdae15f7d66b9ef0b06fb1b36fff3dcd9d8ae47ddc5c4dabcfd2f3",
        platform: "linux",
        lastSeenAt: "2026-09-24T05:00:00.000Z",
      }),
      expect.objectContaining({
        kind: "device",
        approved: false,
        platform: "ios",
        lastSeenAt: null,
      }),
    ]);
    expect(f.tx.deviceGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "owner", spaceId: "space", kind: "device", revokedAt: null },
      }),
    );
    expect(JSON.stringify(rows)).not.toMatch(/token|Key|Roots|ipAddress/);
    await f.service.disconnectDevice(f.actor, { kind: "device", id: "phone" });
    expect(f.revoke).toHaveBeenCalledWith(f.actor, { kind: "device", id: "phone" });
  });
});
