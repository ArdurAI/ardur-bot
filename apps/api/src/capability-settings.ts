import type { JobPublisher, SandboxProvider } from "@ardurbot/adapter-kit";
import { queueComputerUpdate } from "@ardurbot/adapters";
import type { Actor, CapabilityPreferences } from "@ardurbot/contracts";
import {
  CapabilityPreferencesPatchSchema,
  CapabilityPreferencesSchema,
  ComputerNetworkInputSchema,
} from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import { refuseIfEngineMissing } from "./computer-maintenance.js";
import { requireSpaceOwner } from "./memory-provider-config.js";

type Dependencies = { prisma: PrismaClient; jobs: JobPublisher; sandbox: SandboxProvider };
const identity = (actor: Actor) => ({ spaceId: actor.spaceId, userId: actor.userId });
export function createCapabilitySettings(deps: Dependencies) {
  async function member(actor: Actor) {
    const row = await deps.prisma.spaceMember.findUnique({
      where: { spaceId_userId: identity(actor) },
    });
    if (!row) throw new ORPCError("FORBIDDEN");
    return row.role.split(",").some((role) => role.trim() === "owner");
  }
  async function supported(
    computer: {
      id: string;
      homeKey: string;
      kind: string;
      providerRef: string | null;
      connectionId: string | null;
    },
    actor: Actor,
    botId: string,
  ) {
    if (computer.kind === "docker" || computer.kind === "remote-docker") return true;
    if (computer.kind !== "kubernetes" || !deps.sandbox.supportsNetworkEgress) return false;
    return deps.sandbox
      .supportsNetworkEgress(
        {
          ...computer,
          kind: "kubernetes",
          providerRef: computer.providerRef ?? "",
          botId: computer.homeKey,
        },
        {
          ...identity(actor),
          botId,
          operationId: "network-capability",
          traceId: "network-capability",
          signal: AbortSignal.timeout(10_000),
        },
      )
      .catch(() => false);
  }
  return {
    async settings(actor: Actor) {
      const canConfigure = await member(actor);
      const [space, computers] = await Promise.all([
        deps.prisma.space.findUniqueOrThrow({ where: { id: actor.spaceId } }),
        deps.prisma.computer.findMany({
          where: {
            spaceId: actor.spaceId,
            ...(canConfigure ? {} : { userId: actor.userId }),
            bots: { some: { archivedAt: null } },
          },
          include: {
            bots: {
              where: { archivedAt: null },
              select: { id: true, name: true },
              orderBy: { id: "asc" },
            },
          },
          orderBy: { id: "asc" },
        }),
      ]);
      return {
        settings: CapabilityPreferencesSchema.parse(space),
        canConfigure,
        unsupportedRuntimes: [],
        computers: await Promise.all(
          computers.map(async (computer) => ({
            id: computer.id,
            name: computer.bots[0]!.name,
            kind: computer.kind,
            networkEgress: computer.networkEgress,
            pending: Boolean(computer.maintenanceId),
            supported: await supported(computer, actor, computer.bots[0]!.id),
          })),
        ),
      };
    },
    async configure(actor: Actor, patch: Partial<CapabilityPreferences>) {
      await requireSpaceOwner(deps.prisma, actor);
      const data = CapabilityPreferencesPatchSchema.parse(patch);
      return CapabilityPreferencesSchema.parse(
        await deps.prisma.space.update({ where: { id: actor.spaceId }, data }),
      );
    },
    async network(
      actor: Actor,
      input: { computerId: string; networkEgress: boolean; confirmed: true },
    ) {
      await requireSpaceOwner(deps.prisma, actor);
      const request = ComputerNetworkInputSchema.parse(input);
      const computer = await deps.prisma.computer.findFirst({
        where: { id: request.computerId, spaceId: actor.spaceId },
        include: {
          bots: { where: { archivedAt: null }, select: { id: true }, orderBy: { id: "asc" } },
        },
      });
      const botId = computer?.bots[0]?.id;
      if (!computer || !botId) throw new ORPCError("NOT_FOUND");
      if (!(await supported(computer, actor, botId)))
        throw new ORPCError("BAD_REQUEST", {
          message: "Network egress control is unsupported on this computer.",
        });
      await refuseIfEngineMissing(deps.sandbox, computer, {
        ...identity(actor),
        botId,
        operationId: "capabilities.network",
        traceId: "capabilities.network",
        signal: new AbortController().signal,
      });
      return queueComputerUpdate(deps, computer.id, botId, "update", {
        networkEgress: request.networkEgress,
        confirmed: true,
      });
    },
  };
}
