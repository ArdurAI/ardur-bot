import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import { runContinueJob } from "@ardurbot/adapter-kit";
import { discoverFleet, FleetCatalog, localFleetService } from "@ardurbot/adapters";
import type { FleetTarget } from "@ardurbot/contracts";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import {
  FleetTargetSchema,
  PlacementDecisionSchema,
  PlacementSettingsSchema,
} from "@ardurbot/contracts/fleet";
import type { PrismaClient } from "@ardurbot/db";
import { Prisma } from "@ardurbot/db";
import type { RouterDeps } from "./router.js";

const catalogs = new WeakMap<PrismaClient, FleetCatalog>();
export function fleetCatalog(
  deps: Pick<RouterDeps, "prisma" | "secrets" | "env" | "hostBridge" | "sandbox">,
) {
  let catalog = catalogs.get(deps.prisma);
  if (!catalog) {
    catalog = new FleetCatalog(
      deps.prisma,
      deps.secrets,
      {
        supervisorUrl: deps.env.sandboxSupervisorUrl,
        supervisorToken: deps.env.sandboxSupervisorToken,
        ...(deps.hostBridge
          ? {
              hostClient: {
                request: (op, ctx) => deps.hostBridge!.fleetRequest(op, ctx),
                result: (op, ctx) => deps.hostBridge!.fleetResult(op, ctx),
                health: async () => deps.hostBridge!.hub.health,
              },
            }
          : {}),
      },
      deps.sandbox,
    );
    catalogs.set(deps.prisma, catalog);
  }
  return catalog;
}
export async function fleetList(deps: RouterDeps, context: AdapterContext) {
  const fleet = await fleetCatalog(deps).list(context);
  return {
    targets: fleet.targets,
    placement: fleet.placement,
    bots: fleet.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      moveAutomatically: bot.moveAutomatically,
      pending: PlacementDecisionSchema.safeParse(bot.pendingPlacement).success
        ? PlacementDecisionSchema.parse(bot.pendingPlacement)
        : null,
    })),
  };
}
const discoveries = new WeakMap<PrismaClient, { expires: number; value: Promise<FleetTarget[]> }>();
export async function fleetDiscover(deps: RouterDeps, context: AdapterContext) {
  const cached = discoveries.get(deps.prisma);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value =
    process.env.ARDURBOT_HOST_BRIDGE === "api" && deps.hostBridge
      ? deps.hostBridge
          .fleetResult({ op: "computer.remote.discover" }, context)
          .then((value) => FleetTargetSchema.array().parse(value))
      : discoverFleet();
  discoveries.set(deps.prisma, { expires: Date.now() + 30000, value });
  return value;
}
export async function importFleetSecret(
  deps: Pick<RouterDeps, "hostBridge">,
  input: {
    kubeconfig?: string;
    privateKeyPath?: string;
    tlsPaths?: { ca: string; cert: string; key: string };
  },
  context: AdapterContext,
) {
  const operation = { op: "computer.remote.secret" as const, grantId: randomUUID(), ...input };
  return process.env.ARDURBOT_HOST_BRIDGE === "api" && deps.hostBridge
    ? ((await deps.hostBridge.fleetResult(operation, context)) as { id: string })
    : localFleetService().importSecret(operation, context);
}
export async function savePlacement(deps: RouterDeps, context: AdapterContext, input: unknown) {
  const placement = PlacementSettingsSchema.parse(input);
  const resumable = await deps.prisma.$transaction(async (tx) => {
    await tx.space.update({ where: { id: context.spaceId }, data: { placement } });
    if (placement.mode !== "manual") return [];
    const runs = await tx.run.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        status: "waiting_input",
        runtimeComputer: { equals: Prisma.DbNull },
        placement: { path: ["status"], equals: "pending" },
      },
      select: { id: true },
    });
    await tx.run.updateMany({
      where: { id: { in: runs.map((run) => run.id) }, status: "waiting_input" },
      data: {
        status: "queued",
        startedAt: null,
        placement: { status: "declined" },
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    await tx.bot.updateMany({
      where: { spaceId: context.spaceId, userId: context.userId },
      data: { pendingPlacement: Prisma.DbNull },
    });
    return runs;
  });
  for (const run of resumable) await deps.jobs.enqueue(runContinueJob(run.id));
  return placement;
}
export async function fleetBotPreference(
  deps: RouterDeps,
  context: AdapterContext,
  input: { botId: string; moveAutomatically?: boolean; decision?: "accept" | "decline" },
) {
  const runIds = await deps.prisma.$transaction(async (tx) => {
    const bot = await tx.bot.findFirstOrThrow({
      where: { id: input.botId, spaceId: context.spaceId, userId: context.userId },
    });
    if (bot.computerId)
      await tx.$queryRaw`SELECT id FROM computers WHERE id = ${bot.computerId} FOR UPDATE`;
    await tx.bot.update({
      where: { id: bot.id },
      data: {
        ...(input.moveAutomatically !== undefined
          ? {
              moveAutomatically: input.moveAutomatically,
              ...(input.moveAutomatically === false ? { placementConsent: false } : {}),
            }
          : {}),
        ...(input.decision
          ? {
              placementConsent: input.decision === "accept",
              pendingPlacement: input.decision === "accept" ? Prisma.DbNull : { declined: true },
            }
          : input.moveAutomatically
            ? { pendingPlacement: Prisma.DbNull }
            : {}),
      },
    });
    if (!bot.computerId || (!input.decision && !input.moveAutomatically)) return [];
    const owners = await tx.bot.findMany({
      where: { computerId: bot.computerId, archivedAt: null },
    });
    const declined = owners.some(
      (owner) => (owner.pendingPlacement as { declined?: boolean } | null)?.declined,
    );
    if (!declined && owners.some((owner) => !owner.moveAutomatically && !owner.placementConsent))
      return [];
    const where = {
      spaceId: context.spaceId,
      bot: { computerId: bot.computerId, spaceId: context.spaceId },
      status: "waiting_input",
      runtimeComputer: { equals: Prisma.DbNull },
      placement: { path: ["status"], equals: "pending" },
    };
    const pending = await tx.run.findMany({ where, select: { id: true } });
    const resumed: string[] = [];
    for (const run of pending) {
      const changed = await tx.run.updateMany({
        where: { ...where, id: run.id },
        data: {
          status: "queued",
          startedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          placement: declined ? { status: "declined" } : Prisma.DbNull,
        },
      });
      if (changed.count) resumed.push(run.id);
    }
    return resumed;
  });
  for (const runId of runIds) await deps.jobs.enqueue(runContinueJob(runId));
  return { ok: true as const };
}
export async function testFleetTarget(
  deps: RouterDeps,
  context: AdapterContext,
  connectionId: string | null,
) {
  if (!connectionId) {
    await fleetCatalog(deps)
      .testDefault(context)
      .catch(() => undefined);
    return (await fleetCatalog(deps).list(context)).targets;
  }
  const row = await deps.prisma.connection.findFirstOrThrow({
    where: {
      id: connectionId,
      userId: context.userId,
      spaceId: context.spaceId,
      connectorId: "computer",
    },
  });
  const settings = ComputerConnectionSettingsSchema.parse(row.metadata);
  const provider = await fleetCatalog(deps).connections.resolve(connectionId, context);
  const details =
    "test" in provider && typeof provider.test === "function"
      ? ((await provider.test(context)) as { version?: string; os?: string })
      : {};
  fleetCatalog(deps).recordTest(connectionId, details);
  const target = (await fleetCatalog(deps).list(context)).targets.find(
    (target) => target.id === connectionId,
  )!;
  return [{ ...target, ...details, kind: settings.engine }];
}
