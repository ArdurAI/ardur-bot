import { ComputerAdmissionError, withComputerAdmission } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { ACTIVE_RUN_STATUSES } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { createRepos, IsolationError } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";

type Request = { context: { actor: Actor; signal?: AbortSignal }; input: { botId: string } };
/** Screen and Terminal enter through the same takeover grant, including dedicated computers. */
export function guardComputerTakeover<T>(
  prisma: PrismaClient,
  handler: (request: Request) => Promise<T>,
) {
  return async (request: Request): Promise<T> => {
    const bot = await createRepos(prisma).getBot(request.context.actor, request.input.botId);
    if (!bot.computer) throw new IsolationError();
    return withComputerAdmission(
      prisma,
      bot.computer.id,
      async () => {
        const active = await prisma.run.findFirst({
          where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
          select: { id: true, status: true },
        });
        if (
          active &&
          active.status !== "waiting_takeover" &&
          (!bot.computer?.controlRunId || bot.computer.controlRunId !== active.id)
        )
          throw new ORPCError("CONFLICT", { message: "The bot is working — wait or stop it." });
        return handler(request);
      },
      true,
    ).catch((error: unknown) => {
      if (error instanceof ComputerAdmissionError)
        throw new ORPCError("CONFLICT", { message: error.message, cause: error });
      throw error;
    });
  };
}
