import type { Prisma } from "./client.js";

export function resetBriefRetriesForConnection(
  prisma: Prisma.TransactionClient,
  input: { userId: string; credentialId: string; provider: string },
) {
  return prisma.botBrief.updateMany({
    where: {
      userId: input.userId,
      OR: [
        { bot: { modelCredentialId: input.credentialId } },
        {
          bot: {
            modelCredentialId: null,
            OR: [{ modelProvider: input.provider }, { modelProvider: null }],
          },
        },
        {
          thread: {
            group: {
              members: {
                some: {
                  bot: { userId: input.userId },
                  runtimePin: { path: ["credentialId"], equals: input.credentialId },
                },
              },
            },
          },
        },
      ],
    },
    data: { failureCount: 0, nextAttemptAt: null, attemptedAt: null },
  });
}
