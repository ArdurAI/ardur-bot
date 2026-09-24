import { createHash } from "node:crypto";
import type { RuntimePin } from "@ardurbot/contracts";
import { RuntimeInfoSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { Prisma } from "@ardurbot/db";

export async function runtimeSession(
  prisma: PrismaClient,
  input: {
    runId: string;
    threadId: string;
    userId: string;
    spaceId: string;
    botId: string;
    computerId: string | null;
    instructions: string;
    historyGeneration?: number;
    pin: RuntimePin;
  },
) {
  const binding = createHash("sha256")
    .update(
      JSON.stringify([
        input.userId,
        input.spaceId,
        input.botId,
        input.threadId,
        input.computerId,
        input.instructions,
        input.pin,
        ...(input.historyGeneration ? [input.historyGeneration] : []),
      ]),
    )
    .digest("hex");
  const previous = await prisma.run.findFirst({
    where: {
      userId: input.userId,
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      runtimeInfo: { not: Prisma.DbNull },
      OR: [{ id: input.runId }, { status: "completed" }],
    },
    orderBy: { createdAt: "desc" },
    select: { runtimeInfo: true },
  });
  const parsed = RuntimeInfoSchema.safeParse(previous?.runtimeInfo);
  return {
    binding,
    previous: parsed.success && parsed.data.binding === binding ? parsed.data : undefined,
  };
}
