import { createHash } from "node:crypto";
import type { Auth } from "@ardurbot/auth";
import { accountSessions } from "@ardurbot/auth";
import type { AccountProfileInput, AccountSettings, Actor, LocalDevice } from "@ardurbot/contracts";
import {
  AccountInstructionsInputSchema,
  AccountProfileInputSchema,
  WorkTypeSchema,
} from "@ardurbot/contracts";
import { hostRegistrationIdentityText } from "@ardurbot/contracts/host-bridge";
import type { PrismaClient } from "@ardurbot/db";
import { auditDevice } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import type { HostBridge } from "./host-bridge.js";
import type { createRemoteDevices } from "./remote-devices.js";

function owner(actor: Actor) {
  if (!actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
}
export function createAccountService(deps: {
  prisma: PrismaClient;
  auth: Auth;
  hostBridge?: HostBridge;
  remoteDevices: ReturnType<typeof createRemoteDevices>;
}) {
  const { prisma } = deps;
  const sessions = accountSessions(deps.auth);
  async function canEditInstructions(actor: Actor) {
    const member = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    });
    return !!member && ["owner", "admin"].includes(member.role);
  }
  return {
    sessions,
    async get(actor: Actor): Promise<AccountSettings> {
      const [user, space, host, canEdit] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: actor.userId } }),
        prisma.space.findUniqueOrThrow({ where: { id: actor.spaceId } }),
        prisma.hostRegistration.findFirst({ where: { userId: actor.userId } }),
        canEditInstructions(actor),
      ]);
      return {
        name: user.name,
        displayName: user.displayName,
        workType: WorkTypeSchema.parse(user.workType),
        avatarStyle: user.avatarStyle === "organic" ? "organic" : "robot",
        spaceId: actor.spaceId,
        instructions: space.botInstructions,
        instructionsRevision: space.botInstructionsRevision,
        canEditInstructions: canEdit,
        canManageDevices: actor.isDeploymentOwner,
        requireTrustedDevices: space.requireTrustedDevices,
        desktopAvailable: !!host,
      };
    },
    async updateProfile(actor: Actor, input: AccountProfileInput) {
      const data = AccountProfileInputSchema.parse(input);
      await prisma.user.update({ where: { id: actor.userId }, data });
      return data;
    },
    async updateInstructions(actor: Actor, input: { instructions: string; revision: number }) {
      input = AccountInstructionsInputSchema.parse(input);
      if (!(await canEditInstructions(actor))) throw new ORPCError("FORBIDDEN");
      const changed = await prisma.space.updateMany({
        where: { id: actor.spaceId, botInstructionsRevision: input.revision, deletingAt: null },
        data: {
          botInstructions: input.instructions,
          botInstructionsAuthorId: actor.userId,
          botInstructionsRevision: { increment: 1 },
        },
      });
      if (!changed.count)
        throw new ORPCError("CONFLICT", { message: "Instructions changed. Reload before saving." });
      return { revision: input.revision + 1 };
    },
    async setTrustedDevices(actor: Actor, required: boolean) {
      owner(actor);
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
        if (required && !(await tx.hostRegistration.findFirst({ where: { userId: actor.userId } })))
          throw new ORPCError("FORBIDDEN", {
            message: "Connect a desktop app to approve new devices.",
          });
        await tx.space.update({
          where: { id: actor.spaceId },
          data: { requireTrustedDevices: required },
        });
        return { required };
      });
    },
    async approveDevice(actor: Actor, id: string) {
      owner(actor);
      await prisma.$transaction(async (tx) => {
        const grant = await tx.deviceGrant.findFirst({
          where: {
            id,
            userId: actor.userId,
            spaceId: actor.spaceId,
            kind: "device",
            revokedAt: null,
          },
        });
        if (!grant) throw new ORPCError("NOT_FOUND");
        const changed = await tx.deviceGrant.updateMany({
          where: { id, revokedAt: null, trustedAt: null },
          data: { trustedAt: new Date() },
        });
        if (changed.count)
          await auditDevice(tx, "device.approved", {
            instanceId: grant.instanceId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            grantId: id,
          });
      });
      return { ok: true as const };
    },
    async localDevices(actor: Actor): Promise<LocalDevice[]> {
      const [hosts, devices] = await Promise.all([
        prisma.hostRegistration.findMany({
          where: { userId: actor.userId },
          orderBy: { createdAt: "asc" },
        }),
        prisma.deviceGrant.findMany({
          where: { userId: actor.userId, spaceId: actor.spaceId, kind: "device", revokedAt: null },
          orderBy: { createdAt: "asc" },
        }),
      ]);
      return [
        ...hosts.map((host) => ({
          id: host.id,
          kind: "host" as const,
          name: host.name,
          platform: host.platform,
          createdAt: host.createdAt.toISOString(),
          lastSeenAt: host.lastSeenAt?.toISOString() ?? null,
          approved: true,
          registrationId: createHash("sha256")
            .update(hostRegistrationIdentityText(host.tokenHash))
            .digest("hex"),
        })),
        ...devices.map((device) => ({
          id: device.id,
          kind: "device" as const,
          name: device.deviceName,
          platform: device.platform,
          createdAt: device.createdAt.toISOString(),
          lastSeenAt: device.lastUsedAt?.toISOString() ?? null,
          approved: !!device.trustedAt,
        })),
      ];
    },
    async disconnectDevice(actor: Actor, input: { id: string; kind: "host" | "device" }) {
      owner(actor);
      if (input.kind === "device") return deps.remoteDevices.revoke(actor, input);
      if (input.id !== "default" || !deps.hostBridge) throw new ORPCError("NOT_FOUND");
      return deps.hostBridge.disconnect(actor.userId);
    },
  };
}
