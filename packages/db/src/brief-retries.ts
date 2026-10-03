import { getLogger } from "@ardurbot/logging";
import type { Prisma } from "./client.js";
import { Prisma as PrismaValues } from "./client.js";

/** Run after the settings write commits; retry cleanup must not roll back a saved choice. */
export async function resetBriefRetries(
  prisma: Prisma.TransactionClient,
  where: Prisma.BotBriefWhereInput,
): Promise<void> {
  try {
    await prisma.botBrief.updateMany({
      where,
      data: { failureCount: 0, nextAttemptAt: null, attemptedAt: null },
    });
  } catch (error) {
    getLogger().error("brief retry reset", error);
  }
}

export function resetBriefRetriesForConnection(
  prisma: Prisma.TransactionClient,
  input: { userId: string; credentialId: string; provider: string },
) {
  return resetBriefRetries(prisma, {
    userId: input.userId,
    OR: [
      { bot: { modelCredentialId: input.credentialId } },
      { bot: { modelCredentialId: null, modelProvider: input.provider } },
      {
        thread: {
          group: {
            members: {
              some: {
                bot: { userId: input.userId },
                OR: [
                  { runtimePin: { path: ["credentialId"], equals: input.credentialId } },
                  {
                    AND: [
                      { runtimePin: { path: ["provider"], equals: input.provider } },
                      { runtimePin: { path: ["credentialId"], equals: PrismaValues.JsonNull } },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    ],
  });
}
