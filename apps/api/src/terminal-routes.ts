import type { SandboxProvider } from "@ardurbot/adapter-kit";
import {
  ComputerAdmissionError,
  hasActiveComputerControl,
  toComputerRef,
  withComputerAdmission,
} from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { computerCapabilities, TERMINAL_ENDED, TERMINAL_UNAVAILABLE } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError, requireMembership } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import type { TerminalGrant } from "./terminal-gateway.js";
import { TerminalGateway } from "./terminal-gateway.js";

export function createTerminalRoutes(deps: {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  trustedOrigin(origin: string): boolean;
}) {
  async function owned(actor: Actor, botId: string, computerId: string) {
    await requireMembership(deps.prisma, actor.userId, actor.spaceId);
    const bot = await deps.prisma.bot.findFirst({
      where: {
        id: botId,
        userId: actor.userId,
        spaceId: actor.spaceId,
        computerId,
        archivedAt: null,
      },
      include: { computer: true },
    });
    const computer = bot?.computer;
    if (
      !computer ||
      computer.id !== computerId ||
      computer.spaceId !== actor.spaceId ||
      (computer.scope === "team"
        ? computer.scopeKey !== `team:${actor.spaceId}`
        : computer.scope !== "dedicated" || computer.userId !== actor.userId)
    )
      throw new IsolationError();
    return computer;
  }
  const provider = deps.sandbox.terminal;
  const availableOn = (computer: { kind: string; connectionId?: string | null }) =>
    Boolean(
      computerCapabilities(computer.kind).interactiveTerminal &&
        provider &&
        (computer.connectionId || deps.sandbox.describe().capabilities.interactiveTerminal),
    );
  const gateway = provider
    ? new TerminalGateway({
        provider,
        async authorize(grant) {
          const [computer, session] = await Promise.all([
            owned(grant.actor, grant.botId, grant.computerId),
            deps.prisma.session.findFirst({
              where: {
                id: grant.authSessionId,
                userId: grant.actor.userId,
                expiresAt: { gt: new Date() },
              },
              select: { id: true },
            }),
          ]);
          if (
            !session ||
            computer.screenGeneration !== grant.computerGeneration ||
            !availableOn(computer) ||
            computer.state !== "running" ||
            computer.maintenanceId ||
            !hasActiveComputerControl(computer) ||
            computer.controlBotId !== grant.botId ||
            computer.controlLeaseId !== grant.context.leaseId ||
            computer.controlFence !== grant.context.fence ||
            computer.providerRef !== grant.context.generation
          )
            throw new IsolationError();
        },
        async audit(type, grant, sessionId, reason) {
          await deps.prisma.terminalAudit.create({
            data: {
              actorUserId: grant.actor.userId,
              spaceId: grant.actor.spaceId,
              computerId: grant.computerId,
              botId: grant.botId,
              sessionRef: sessionId,
              leaseFence: grant.context.fence,
              type,
              reason,
            },
          });
        },
      })
    : undefined;
  return {
    gateway,
    async close(actor: Actor, input: { botId: string; computerId: string; sessionId: string }) {
      await owned(actor, input.botId, input.computerId);
      await gateway?.closeOwned(actor, input.botId, input.computerId, input.sessionId);
      return { ok: true as const };
    },
    async available(actor: Actor, input: { botId: string; computerId: string }) {
      const computer = await owned(actor, input.botId, input.computerId);
      return {
        available: availableOn(computer),
      };
    },
    async ticket(
      actor: Actor,
      input: { botId: string; computerId: string; sessionId?: string; workspace?: "computer" },
      authSessionId: string | undefined,
      origin: string | undefined,
    ) {
      let requestAudited = false;
      try {
        if (!gateway) throw new Error(TERMINAL_UNAVAILABLE);
        if (!authSessionId || !origin || !deps.trustedOrigin(origin)) throw new IsolationError();
        if (!availableOn(await owned(actor, input.botId, input.computerId)))
          throw new Error(TERMINAL_UNAVAILABLE);
        return await withComputerAdmission(
          deps.prisma,
          input.computerId,
          async () => {
            let computer = await owned(actor, input.botId, input.computerId);
            if (
              !computer.providerRef ||
              !availableOn(computer) ||
              !hasActiveComputerControl(computer) ||
              computer.controlBotId !== input.botId
            )
              throw new IsolationError();
            if (
              !input.sessionId &&
              [...gateway.sessions.values()].some(
                (session) => session.grant.computerId === input.computerId,
              )
            )
              throw new ComputerAdmissionError(
                "A terminal is already open. Close it before opening another.",
              );
            if (!input.sessionId) {
              computer = await deps.prisma.computer.update({
                where: { id: computer.id, controlLeaseId: computer.controlLeaseId },
                data: { controlFence: { increment: 1 } },
              });
            }
            const grant: TerminalGrant = {
              actor,
              botId: input.botId,
              computerId: computer.id,
              computerGeneration: computer.screenGeneration,
              authSessionId,
              computer: toComputerRef(computer),
              context: {
                operationId: "terminal.open",
                traceId: "terminal.open",
                userId: actor.userId,
                spaceId: actor.spaceId,
                botId: input.botId,
                signal: new AbortController().signal,
                leaseId: computer.controlLeaseId!,
                fence: computer.controlFence,
                generation: computer.providerRef!,
                expiresAt: computer.controlLeaseExpiresAt!.getTime(),
                workingRoot: "",
              },
            };
            const workingRoot = await deps.sandbox.resolveCommandCwd?.(
              grant.computer,
              computer.scope === "team" && input.workspace !== "computer"
                ? `bots/${input.botId}`
                : undefined,
              grant.context,
            );
            if (!workingRoot) throw new Error(TERMINAL_UNAVAILABLE);
            grant.context.workingRoot = workingRoot;
            requestAudited = true;
            return gateway.request(grant, origin, input.sessionId);
          },
          true,
        );
      } catch (error) {
        if (!requestAudited) {
          await deps.prisma.terminalAudit.create({
            data: {
              actorUserId: actor.userId,
              spaceId: actor.spaceId,
              computerId: input.computerId,
              botId: input.botId,
              sessionRef: input.sessionId ?? "",
              leaseFence: 0,
              type: "requested",
              reason: "human-request",
            },
          });
          await deps.prisma.terminalAudit.create({
            data: {
              actorUserId: actor.userId,
              spaceId: actor.spaceId,
              computerId: input.computerId,
              botId: input.botId,
              sessionRef: input.sessionId ?? "",
              leaseFence: 0,
              type: "denied",
              reason: "authorization-or-session",
            },
          });
        }
        if (error instanceof ComputerAdmissionError)
          throw new ORPCError("CONFLICT", { message: error.message });
        if (error instanceof Error && error.message === TERMINAL_UNAVAILABLE)
          throw new ORPCError("BAD_REQUEST", { message: TERMINAL_UNAVAILABLE });
        if (error instanceof Error && error.message === TERMINAL_ENDED)
          throw new ORPCError("CONFLICT", { message: TERMINAL_ENDED });
        throw new ORPCError("FORBIDDEN", {
          message: "Take control of the computer, then open a terminal.",
        });
      }
    },
  };
}
