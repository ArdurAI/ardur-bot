import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { PrismaClient, Run } from "@ardurbot/db";
import { toComputerRef } from "./computer-support.js";

/** Stop an existing computer without resolving a model or provisioning a new computer. */
export async function stoppedRunComputer(prisma: PrismaClient, run: Run, computerId: string) {
  const computer = await prisma.computer.findFirst({
    where: { id: computerId, spaceId: run.spaceId, userId: run.userId },
  });
  if (!computer?.providerRef) return undefined;
  const context: AdapterContext = {
    operationId: `stop:${run.id}`,
    traceId: run.id,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    signal: AbortSignal.timeout(30_000),
  };
  return { computer: toComputerRef(computer), context };
}
