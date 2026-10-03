import type { HermesRuntimeConfigV2Draft } from "@ardurbot/contracts/runtime-config";
import {
  canonicalRuntimeJson,
  effectiveHermesRuntimeConfigV2,
  normalizeHermesRuntimeConfig,
} from "@ardurbot/core/runtime-config";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { appendEventInTransaction, resetBriefRetries } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import { ORPCError } from "@orpc/server";

type AppendEvent = typeof appendEventInTransaction;

/** Decide whether an editor save changes execution, before the fenced row update. */
export function prepareRuntimeConfigSave(
  existing: { runtimeKind?: string; runtimeConfig?: unknown; modelPinRevision: number },
  input: {
    runtimeKind?: string;
    runtimeConfig?: HermesRuntimeConfigV2Draft | null;
    expectedModelPinRevision?: number;
  },
  pinChanged: boolean,
) {
  if (input.runtimeConfig !== undefined && (input.runtimeKind ?? existing.runtimeKind) !== "hermes")
    throw new ORPCError("BAD_REQUEST", { message: "Hermes settings require the Hermes runtime." });
  const runtimeConfig =
    input.runtimeConfig == null ? null : normalizeHermesRuntimeConfig(input.runtimeConfig);
  const configChanged =
    input.runtimeConfig !== undefined &&
    canonicalRuntimeJson(effectiveHermesRuntimeConfigV2(existing.runtimeConfig)) !==
      canonicalRuntimeJson(effectiveHermesRuntimeConfigV2(runtimeConfig));
  const executionChanged = pinChanged || configChanged;
  if (executionChanged) {
    if (input.expectedModelPinRevision === undefined)
      throw new ORPCError("BAD_REQUEST", { message: "Reload bot settings before saving." });
    if (input.expectedModelPinRevision !== existing.modelPinRevision)
      throw new ORPCError("CONFLICT", { message: "Bot settings changed. Reload before saving." });
    if (existing.modelPinRevision >= 2_147_483_647)
      throw new ORPCError("CONFLICT", { message: "Bot settings revision cannot advance." });
  }
  return {
    configChanged,
    runtimeConfig,
    incrementRevision: configChanged && !pinChanged,
    expectedModelPinRevision: executionChanged ? existing.modelPinRevision : undefined,
  };
}

/**
 * Persist a bot row. When profile labels change, write `bot.updated` in the same
 * transaction so clients never observe a successful rename without a durable event.
 * Realtime notify stays best-effort after commit.
 */
export async function commitBotUpdate(
  options: {
    prisma: PrismaClient;
    notify: (threadId: string, seq: number) => Promise<void>;
    spaceId: string;
    threadId: string;
    botId: string;
    expectedModelPinRevision?: number;
    data: Prisma.BotUncheckedUpdateInput;
    emitBotUpdated: boolean;
    resetBriefRetries?: boolean;
  },
  appendEvent: AppendEvent = appendEventInTransaction,
): Promise<{ id: string; name: string; title: string; description: string }> {
  const data = options.data;
  const resetRetries = () =>
    options.resetBriefRetries || options.data.modelPinRevision !== undefined
      ? resetBriefRetries(options.prisma, { botId: options.botId })
      : Promise.resolve();
  try {
    if (!options.emitBotUpdated) {
      const updated = await options.prisma.bot.update({
        where: {
          id: options.botId,
          ...(options.expectedModelPinRevision === undefined
            ? {}
            : { modelPinRevision: options.expectedModelPinRevision }),
        },
        data,
        select: { id: true, name: true, title: true, description: true },
      });
      await resetRetries();
      return updated;
    }

    const committed = await options.prisma.$transaction(async (tx) => {
      const updated = await tx.bot.update({
        where: {
          id: options.botId,
          ...(options.expectedModelPinRevision === undefined
            ? {}
            : { modelPinRevision: options.expectedModelPinRevision }),
        },
        data,
        select: { id: true, name: true, title: true, description: true },
      });
      const event = await appendEvent(tx, {
        spaceId: options.spaceId,
        threadId: options.threadId,
        botId: options.botId,
        type: "bot.updated",
        payload: {
          botId: updated.id,
          name: updated.name,
          title: updated.title,
          description: updated.description,
        },
      });
      return { updated, seq: event.seq };
    });

    await resetRetries();
    await options.notify(options.threadId, committed.seq).catch((error) => {
      getLogger().error("bot.updated realtime notification", error);
    });
    return committed.updated;
  } catch (error: any) {
    if (error?.code === "P2025" && options.expectedModelPinRevision !== undefined) {
      throw new ORPCError("CONFLICT", {
        message: "The bot's configuration was updated by another session.",
      });
    }
    throw error;
  }
}

export function botProfileLabelsChanged(input: {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  color?: unknown;
}): boolean {
  return (
    input.name !== undefined ||
    input.title !== undefined ||
    input.description !== undefined ||
    input.color !== undefined
  );
}
