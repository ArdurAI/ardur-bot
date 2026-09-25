import type { AdapterContext } from "@ardurbot/adapter-kit";
import { choosePlacement, PlacementSettingsSchema } from "@ardurbot/contracts/fleet";
import { appendEventInTransaction, createThreadMessageInTransaction, Prisma } from "@ardurbot/db";
import { ComputerBusyError, replaceComputer } from "../computer-lifecycle.js";
import type { FleetCatalog } from "./catalog.js";
import { fleetComputerTargetId } from "./catalog.js";

type Deps = Parameters<typeof replaceComputer>[0];
/** Called before the first computer lease/tool effect, never on a resumed run snapshot. */
export async function placeRunComputer(
  deps: Deps,
  catalog: FleetCatalog,
  runId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const run = await deps.prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: { bot: { include: { computer: { include: { bots: true } } } } },
  });
  if (
    run.runtimeComputer ||
    run.bot.runtimeKind !== "pi" ||
    (run.placement as { status?: string } | null)?.status === "declined"
  )
    return true;
  signal.throwIfAborted();
  const ownedRun = {
    id: runId,
    status: "running",
    cancelRequestedAt: null,
    leaseOwner: run.leaseOwner,
    leaseFence: run.leaseFence,
  };
  const space = await deps.prisma.space.findUniqueOrThrow({
    where: { id: run.spaceId },
    select: { placement: true },
  });
  const policy = PlacementSettingsSchema.parse(space.placement ?? {});
  if (policy.mode === "manual") return true;
  const computer = run.bot.computer;
  if (!computer || computer.maintenanceId || computer.controlHolder === "user") return true;
  const context: AdapterContext = {
    operationId: runId,
    traceId: runId,
    runId,
    botId: run.botId,
    spaceId: run.spaceId,
    userId: run.userId,
    signal,
  };
  const fleet = await catalog.list(context);
  const from = fleetComputerTargetId(computer, fleet);
  let candidates = fleet.targets.filter(
    (target) =>
      target.connectionId !== null || target.id === fleet.defaultTargetId || target.id === from,
  );
  if (computer.networkEgress === false) {
    const supported = new Set([from]);
    for (const target of candidates) {
      if (target.id === from || target.state !== "connected" || target.kind === "host") continue;
      const provider = target.connectionId
        ? await catalog.connections.resolve(target.connectionId, context)
        : deps.sandbox;
      if (
        await provider
          .supportsNetworkEgress?.(
            {
              id: computer.id,
              botId: computer.homeKey,
              providerRef: computer.providerRef ?? "",
              connectionId: target.connectionId,
              kind: target.kind === "kubernetes" ? "kubernetes" : "docker",
            },
            context,
          )
          .catch(() => false)
      )
        supported.add(target.id);
    }
    candidates = candidates.filter((target) => supported.has(target.id));
  }
  const decision = choosePlacement(policy, from, candidates);
  if (!decision) return true;
  const owners = computer.bots.filter((bot) => bot.archivedAt === null);
  if (
    owners.some(
      (bot) =>
        bot.runtimeKind !== "pi" ||
        (bot.pendingPlacement as { declined?: boolean } | null)?.declined,
    )
  )
    return true;
  const unapproved = owners.filter((bot) => !bot.moveAutomatically && !bot.placementConsent);
  if (unapproved.length) {
    const requested = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM computers WHERE id = ${computer.id} FOR UPDATE`;
      const pending = await tx.run.findFirst({
        where: {
          id: { not: runId },
          spaceId: run.spaceId,
          bot: { computerId: computer.id },
          status: "waiting_input",
          runtimeComputer: { equals: Prisma.DbNull },
          placement: { path: ["status"], equals: "pending" },
        },
        select: { id: true },
      });
      // Consent is shared by the computer: a later run must not replace its controls.
      if (pending) return true;
      // Match run admission's bot-before-thread order when publishing the shared controls.
      await tx.$queryRaw`SELECT id FROM bots WHERE "computerId" = ${computer.id} ORDER BY id FOR UPDATE`;
      const currentOwners = await tx.bot.findMany({
        where: { computerId: computer.id, archivedAt: null },
      });
      const waiting = currentOwners.filter(
        (bot) => !bot.moveAutomatically && !bot.placementConsent,
      );
      if (
        !waiting.length ||
        currentOwners.some(
          (bot) =>
            bot.runtimeKind !== "pi" ||
            (bot.pendingPlacement as { declined?: boolean } | null)?.declined,
        )
      )
        return true;
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      const paused = await tx.run.updateMany({
        where: ownedRun,
        data: {
          status: "waiting_input",
          placement: { ...decision, status: "pending" },
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (paused.count !== 1) return null;
      for (const bot of waiting)
        await tx.bot.update({
          where: { id: bot.id },
          data: { pendingPlacement: { ...decision, runId } },
        });
      return appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId,
        type: "computer.placement.requested",
        payload: { ...decision, botIds: waiting.map((bot) => bot.id) },
      });
    });
    if (requested === true) return true;
    if (requested) await deps.events.notify(run.threadId, requested.seq).catch(() => undefined);
    return false;
  }
  signal.throwIfAborted();
  const target = candidates.find((target) => target.id === decision.targetId)!;
  const reason = `Moved to ${target.name}: ${decision.reason}`;
  let updateId: string;
  try {
    updateId = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM computers WHERE id = ${computer.id} FOR UPDATE`;
      const currentOwners = await tx.bot.findMany({
        where: { computerId: computer.id, archivedAt: null },
      });
      if (
        currentOwners.some(
          (bot) =>
            bot.runtimeKind !== "pi" ||
            (!bot.moveAutomatically && !bot.placementConsent) ||
            (bot.pendingPlacement as { declined?: boolean } | null)?.declined,
        )
      )
        throw new ComputerBusyError();
      const foreign = await tx.run.findFirst({
        where: {
          id: { not: runId },
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
          bot: { computerId: computer.id },
        },
        select: { id: true },
      });
      if (foreign) throw new ComputerBusyError();
      const moving = await tx.run.updateMany({
        where: ownedRun,
        data: { placement: { ...decision, status: "moving", reason } },
      });
      if (moving.count !== 1) throw new Error("Placement run is no longer active.");
      const update = await tx.computerUpdate.create({
        data: {
          computerId: computer.id,
          botId: run.botId,
          action: "update",
          status: "running",
          stage: "preparing",
          configuration: {
            connectionId: decision.connectionId,
            imageProfile: computer.imageProfile,
            confirmed: true,
            placementRunId: runId,
          },
        },
      });
      const claimed = await tx.computer.updateMany({
        where: {
          id: computer.id,
          maintenanceId: null,
          state: { notIn: ["booting", "suspending"] },
          controlHolder: { not: "user" },
          executionLeases: { none: { expiresAt: { gt: new Date() } } },
        },
        data: { maintenanceId: update.id },
      });
      if (claimed.count !== 1) throw new ComputerBusyError();
      return update.id;
    });
  } catch (error) {
    if (error instanceof ComputerBusyError) return true;
    throw error;
  }
  const abort = new AbortController();
  const heartbeat = setInterval(() => {
    void Promise.all([
      deps.prisma.run.updateMany({
        where: {
          id: runId,
          leaseOwner: run.leaseOwner,
          leaseFence: run.leaseFence,
          status: "running",
          cancelRequestedAt: null,
        },
        data: { leaseExpiresAt: new Date(Date.now() + 5 * 60_000) },
      }),
      deps.prisma.computerUpdate.updateMany({
        where: { id: updateId, status: "running" },
        data: { updatedAt: new Date() },
      }),
    ]).then(
      (results) => {
        if (results.some((result) => result.count !== 1)) abort.abort();
      },
      () => abort.abort(),
    );
  }, 30_000);
  try {
    const moveSignal = AbortSignal.any([signal, abort.signal]);
    moveSignal.throwIfAborted();
    await replaceComputer(
      deps,
      computer.id,
      "update",
      { ...context, operationId: updateId, signal: moveSignal },
      "none",
      async (stage) => {
        moveSignal.throwIfAborted();
        const active = await deps.prisma.run.updateMany({
          where: ownedRun,
          data: { leaseExpiresAt: new Date(Date.now() + 5 * 60_000) },
        });
        if (active.count !== 1) throw new Error("Placement run is no longer active.");
        await deps.prisma.computerUpdate.update({ where: { id: updateId }, data: { stage } });
      },
      {
        imageProfile: computer.imageProfile as "base" | "developer",
        connectionId: decision.connectionId,
        placementRunId: runId,
      },
    );
    const committed = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      const moved = await tx.run.updateMany({
        where: ownedRun,
        data: { placement: { ...decision, status: "moved", reason } },
      });
      await tx.bot.updateMany({
        where: { computerId: computer.id },
        data: { pendingPlacement: Prisma.DbNull },
      });
      await tx.computerUpdate.update({ where: { id: updateId }, data: { status: "completed" } });
      if (moved.count !== 1) return null;
      const blocks = [{ kind: "text" as const, text: reason }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        botId: run.botId,
        runId,
        role: "system",
        blocks,
      });
      return appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "system", blocks },
      });
    });
    if (committed) await deps.events.notify(run.threadId, committed.seq).catch(() => undefined);
    return committed !== null;
  } catch (error) {
    await deps.prisma.computerUpdate.updateMany({
      where: { id: updateId, status: "running" },
      data: { status: "failed" },
    });
    await deps.prisma.run.updateMany({
      where: ownedRun,
      data: { placement: { ...decision, status: "failed" } },
    });
    // The executor finalizes this failure with its normal task/event transaction.
    throw error;
  } finally {
    clearInterval(heartbeat);
    await deps.prisma.computer.updateMany({
      where: { id: computer.id, maintenanceId: updateId },
      data: { maintenanceId: null },
    });
  }
}
