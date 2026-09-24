import type { MessageBlock, RuntimePin } from "@ardurbot/contracts";
import { spaceDefaultEffort } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  findUserModelCredentials,
  withTransactionRetry,
} from "@ardurbot/db";
import type { Logger } from "@ardurbot/logging";
import { modelCredentialDto } from "./model-connect.js";
import { listPiCatalog } from "./pi-models.js";
import type { EncryptedSecretStore } from "./secrets.js";

const legacyPin = {
  modelProvider: { not: null },
  modelCredentialId: null,
  modelPinRevision: 0,
} as const;

/** Bind only unambiguous pre-pin rows; the revision makes this a one-time change per bot. */
export async function backfillRuntimePins({
  prisma,
  secrets,
  logger,
}: {
  prisma: PrismaClient;
  secrets: Pick<EncryptedSecretStore, "load">;
  logger: Pick<Logger, "info">;
}) {
  const counts = { bound: 0, withoutConnection: 0, severalConnections: 0, skipped: 0 };
  const candidates = await prisma.bot.findMany({ where: legacyPin, select: { id: true } });
  const catalog = listPiCatalog();
  for (const candidate of candidates) {
    const outcome = await withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const bot = await tx.bot.findFirst({ where: { id: candidate.id, ...legacyPin } });
          if (!bot?.modelProvider) return "skipped";
          const credentials = await findUserModelCredentials(tx, bot.userId, bot.modelProvider);
          if (!credentials.length) return "withoutConnection";
          if (credentials.length !== 1) return "severalConnections";
          const credential = credentials[0]!;
          // Never attach the audit record to another owner's or space's conversation.
          const thread = await tx.thread.findFirst({
            where: { botId: bot.id, userId: bot.userId, spaceId: bot.spaceId },
            select: { id: true },
          });
          if (!thread) return "skipped";

          let effort = bot.thinkingLevel;
          if (effort === null) {
            const entry = catalog.find(
              (item) => item.provider === bot.modelProvider && item.id === bot.modelId,
            );
            let metadata: ReturnType<typeof modelCredentialDto> | undefined;
            if (credential.provider === "openai-compatible") {
              const secret = await tx.secret.findFirst({
                where: { id: credential.secretId, userId: bot.userId, spaceId: null },
              });
              // Without the stored capabilities, the old effective effort is unknowable.
              if (!secret) return "skipped";
              metadata = modelCredentialDto(
                { ...credential, isDefault: false, defaultModel: bot.modelId },
                secrets.load(secret.ciphertext, secret.id),
              );
            }
            if (!entry && !metadata) return "skipped";
            effort =
              metadata?.thinkingLevel ??
              spaceDefaultEffort(
                metadata?.reasoning ?? entry?.reasoning ?? false,
                metadata?.thinkingLevels ?? entry?.thinkingLevels,
              );
          }
          const updated = await tx.bot.updateMany({
            where: {
              id: bot.id,
              userId: bot.userId,
              spaceId: bot.spaceId,
              ...legacyPin,
              modelProvider: bot.modelProvider,
              modelId: bot.modelId,
              thinkingLevel: bot.thinkingLevel,
            },
            data: { modelCredentialId: credential.id, thinkingLevel: effort, modelPinRevision: 1 },
          });
          if (!updated.count) return "skipped";
          const pin: RuntimePin = {
            provider: bot.modelProvider,
            modelId: bot.modelId,
            effort,
            credentialId: credential.id,
            revision: 1,
          };
          const eventScope = { spaceId: bot.spaceId, threadId: thread.id, botId: bot.id };
          await appendEventInTransaction(tx, {
            ...eventScope,
            type: "bot.pinBackfilled",
            payload: { pin },
          });
          const blocks: MessageBlock[] = [
            {
              kind: "text",
              text: `Connection bound to ${credential.label} for ${pin.provider} · ${pin.modelId} · ${pin.effort}.`,
            },
          ];
          const message = await createThreadMessageInTransaction(tx, {
            threadId: thread.id,
            botId: bot.id,
            role: "system",
            blocks,
          });
          await appendEventInTransaction(tx, {
            ...eventScope,
            type: "thread.message.created",
            payload: { messageId: message.id, role: "system", blocks },
          });
          return "bound";
        },
        { isolationLevel: "Serializable" },
      ),
    );
    counts[outcome] += 1;
  }
  logger.info("runtime pin backfill", counts);
  return counts;
}
