import type { AccountInstructionContext } from "@ardurbot/contracts";
import { AccountInstructionContextSchema, WorkTypeSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";

/** Resumed runs retain the exact human-authored revision supplied on their first attempt. */
export async function loadAccountInstructionContext(
  prisma: PrismaClient,
  run: { userId: string; spaceId: string; accountInstructionContext?: unknown },
): Promise<AccountInstructionContext> {
  if (run.accountInstructionContext != null)
    return AccountInstructionContextSchema.parse(run.accountInstructionContext);
  const [user, space] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: run.userId },
      select: { displayName: true, workType: true },
    }),
    prisma.space.findUniqueOrThrow({
      where: { id: run.spaceId },
      select: {
        botInstructions: true,
        botInstructionsAuthorId: true,
        botInstructionsRevision: true,
      },
    }),
  ]);
  return {
    displayName: user.displayName,
    workType: WorkTypeSchema.parse(user.workType),
    instructions: space.botInstructions,
    revision: space.botInstructionsRevision,
    actorId: space.botInstructionsAuthorId,
    origin: "human-settings",
  };
}
