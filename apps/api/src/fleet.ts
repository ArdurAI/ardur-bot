import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import { runContinueJob } from "@ardurbot/adapter-kit";
import { discoverFleet, FleetCatalog, localFleetService } from "@ardurbot/adapters";
import type { FleetTarget } from "@ardurbot/contracts";
import {
  ComputerConnectionSettingsSchema,
  FLEET_PINNED_BOTS_CONFLICT_CODE,
} from "@ardurbot/contracts";
import {
  FleetTargetSchema,
  PlacementDecisionSchema,
  PlacementSettingsSchema,
} from "@ardurbot/contracts/fleet";
import { ACTIVE_RUN_STATUSES } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { Prisma } from "@ardurbot/db";
import { engineFailureReason } from "@ardurbot/host-runtime/fleet/probe";
import { ORPCError } from "@orpc/server";
import type { HostBridge } from "./host-bridge.js";
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
    hostLabel: fleet.hostLabel,
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

/** Host deletion is idempotent, so a lost response leaves the intent safe to retry. */
export async function cleanupFleetSecret(
  prisma: PrismaClient,
  hostBridge: HostBridge | undefined,
  context: AdapterContext,
  hostSecretId: string,
) {
  try {
    const op = { op: "computer.remote.secret.delete" as const, secretId: hostSecretId };
    if (process.env.ARDURBOT_HOST_BRIDGE === "api") {
      if (!hostBridge) throw new Error("Host bridge is unavailable.");
      await hostBridge.fleetResult(op, context);
    } else await localFleetService().deleteSecret(hostSecretId);
    await prisma.fleetSecretCleanup.deleteMany({ where: { hostSecretId } });
    return true;
  } catch {
    // The intent survives both a disconnected host and an ambiguous deletion response.
    await prisma.fleetSecretCleanup
      .updateMany({
        where: { hostSecretId },
        data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 30_000) },
      })
      .catch(() => undefined);
    return false;
  }
}

/** Startup and periodic sweep, including cleanup intents left by a previous process. */
export async function reconcileFleetSecretCleanup(prisma: PrismaClient, hostBridge?: HostBridge) {
  const due = await prisma.fleetSecretCleanup.findMany({
    where: { nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  for (const intent of due) {
    await cleanupFleetSecret(
      prisma,
      hostBridge,
      {
        spaceId: intent.spaceId,
        userId: intent.userId,
        operationId: `fleet-secret-cleanup:${intent.hostSecretId}`,
        traceId: `fleet-secret-cleanup:${intent.hostSecretId}`,
        signal: new AbortController().signal,
      },
      intent.hostSecretId,
    );
  }
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
    const checkedAt = new Date().toISOString();
    try {
      await fleetCatalog(deps).testDefault(context);
    } catch (error) {
      const reason = engineFailureReason(error);
      if (!reason) throw error;
      fleetCatalog(deps).recordTest("default", {
        reachability: { status: "installed-not-running", reason, checkedAt },
      });
      return {
        ok: false as const,
        reason,
        checkedAt,
        targets: (await fleetCatalog(deps).list(context)).targets,
      };
    }
    return {
      ok: true as const,
      checkedAt,
      targets: (await fleetCatalog(deps).list(context)).targets,
    };
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
  const checkedAt = new Date().toISOString();
  let details: { version?: string; os?: string; capacity?: FleetTarget["capacity"] };
  try {
    const probeContext = {
      ...context,
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(5000)]),
    };
    if ("test" in provider && typeof provider.test === "function")
      details = (await provider.test(probeContext)) as typeof details;
    else if ("engineInfo" in provider && typeof provider.engineInfo === "function")
      details = (await provider.engineInfo(probeContext)) as typeof details;
    else {
      const capacity = await provider.capacity?.(probeContext);
      if (!capacity || capacity.source === "not-reported")
        throw new Error("Computer test is unavailable.");
      details = { capacity };
    }
  } catch (error) {
    const reason = engineFailureReason(error);
    if (!reason) throw error;
    fleetCatalog(deps).recordTest(connectionId, {
      reachability: {
        status:
          settings.endpoint?.startsWith("ssh://") || settings.endpoint?.startsWith("tcp://")
            ? "not-reachable"
            : "installed-not-running",
        reason,
        checkedAt,
      },
    });
    const target = (await fleetCatalog(deps).list(context)).targets.find(
      (target) => target.id === connectionId,
    )!;
    return { ok: false as const, reason, checkedAt, targets: [target] };
  }
  fleetCatalog(deps).recordTest(connectionId, {
    ...details,
    reachability: { status: "running", checkedAt },
  });
  const target = (await fleetCatalog(deps).list(context)).targets.find(
    (target) => target.id === connectionId,
  )!;
  return {
    ok: true as const,
    checkedAt,
    targets: [{ ...target, ...details, kind: settings.engine }],
  };
}

export async function fleetConnectionDetails(
  deps: RouterDeps,
  context: AdapterContext,
  id: string,
) {
  const row = await deps.prisma.connection.findFirstOrThrow({
    where: { id, spaceId: context.spaceId, userId: context.userId, connectorId: "computer" },
  });
  const settings = ComputerConnectionSettingsSchema.parse(row.metadata);
  const { hostSecretId: _hostSecretId, ...visibleSettings } = settings;
  const secret = row.secretId
    ? await deps.prisma.secret.findFirst({
        where: { id: row.secretId, spaceId: context.spaceId, userId: context.userId },
      })
    : null;
  const source = secret
    ? (JSON.parse(deps.secrets.load(secret.ciphertext, secret.id)) as { path?: string })
    : null;
  return {
    id: row.id,
    name: row.displayName,
    revision: row.updatedAt.toISOString(),
    settings: visibleSettings,
    ...(source?.path ? { kubeconfigPath: source.path } : {}),
    hasCredential: Boolean(settings.hostSecretId || secret),
    activeRuns: Boolean(
      await deps.prisma.run.findFirst({
        where: {
          spaceId: context.spaceId,
          userId: context.userId,
          status: { in: [...ACTIVE_RUN_STATUSES] },
          bot: { computer: { connectionId: id } },
        },
        select: { id: true },
      }),
    ),
  };
}

export async function removeFleetTarget(deps: RouterDeps, context: AdapterContext, id: string) {
  const hostSecretId = await deps.prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM connections WHERE id = ${id} AND "spaceId" = ${context.spaceId} AND "userId" = ${context.userId} AND "connectorId" = 'computer' FOR UPDATE`;
      const row = await tx.connection.findFirstOrThrow({
        where: { id, spaceId: context.spaceId, userId: context.userId, connectorId: "computer" },
      });
      const pinned = await tx.bot.findMany({
        where: { spaceId: context.spaceId, userId: context.userId, computer: { connectionId: id } },
        select: { name: true },
        orderBy: { name: "asc" },
      });
      if (pinned.length) {
        const names = pinned.map((bot) => bot.name).join(", ");
        throw new ORPCError("CONFLICT", {
          message: `${pinned.length} ${pinned.length === 1 ? "bot runs" : "bots run"} on this computer: ${names}. Move ${pinned.length === 1 ? "it" : "them"} first.`,
          data: {
            code: FLEET_PINNED_BOTS_CONFLICT_CODE,
            botNames: pinned.map((bot) => bot.name),
            count: pinned.length,
          },
        });
      }
      const computers = await tx.computer.findMany({
        where: { spaceId: context.spaceId, userId: context.userId, connectionId: id },
        select: { id: true },
      });
      await tx.computerAdmission.deleteMany({
        where: { computerId: { in: computers.map((computer) => computer.id) } },
      });
      const deleted = await tx.computer.deleteMany({
        where: {
          id: { in: computers.map((computer) => computer.id) },
          spaceId: context.spaceId,
          userId: context.userId,
          bots: { none: {} },
        },
      });
      if (deleted.count !== computers.length)
        throw new ORPCError("CONFLICT", {
          message: "A bot now runs on this computer. Move it first.",
        });
      const space = await tx.space.findUniqueOrThrow({
        where: { id: context.spaceId },
        select: { placement: true },
      });
      const placement = PlacementSettingsSchema.parse(space.placement ?? {});
      if (placement.preferredTargetId === id)
        await tx.space.update({
          where: { id: context.spaceId },
          data: { placement: { ...placement, preferredTargetId: "host" } },
        });
      await tx.connection.delete({ where: { id: row.id } });
      if (row.secretId)
        await tx.secret.deleteMany({
          where: { id: row.secretId, spaceId: context.spaceId, userId: context.userId },
        });
      await tx.fleetAudit.create({
        data: {
          spaceId: context.spaceId,
          userId: context.userId,
          connectionId: id,
          action: "removed",
        },
      });
      const hostSecretId = ComputerConnectionSettingsSchema.parse(row.metadata).hostSecretId;
      if (hostSecretId)
        await tx.fleetSecretCleanup.create({
          data: { hostSecretId, spaceId: context.spaceId, userId: context.userId },
        });
      return hostSecretId;
    },
    { timeout: 15_000 },
  );
  if (hostSecretId) await cleanupFleetSecret(deps.prisma, deps.hostBridge, context, hostSecretId);
  fleetCatalog(deps).connections.invalidate(id, context.spaceId);
  fleetCatalog(deps).recordTest(id, {});
  return { ok: true as const };
}
