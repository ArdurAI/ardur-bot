import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type {
  Actor,
  ResolvedPin,
  RuntimePin,
  RuntimeProblem,
  ThinkingLevel,
} from "@ardurbot/contracts";
import { runtimePinProblem, ThinkingLevelSchema, usableModelId } from "@ardurbot/contracts";
import type { findDefaultModelCredential, PrismaClient } from "@ardurbot/db";
import { findBoundModelCredential } from "@ardurbot/db";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { listPiCatalog } from "./pi-models.js";
import { modelsForRequest } from "./pi-runtime.js";

type ModelCredential = Awaited<ReturnType<typeof findDefaultModelCredential>>;

/** Resolves only the requested selection. Suggestions belong to editing, never this path. */
export function selectConfiguredModel(input: {
  pin: RuntimePin;
  credential: ModelCredential;
}): (ResolvedPin & { credential: ModelCredential }) | RuntimeProblem {
  const { pin, credential } = input;
  if (!pin.provider || !usableModelId(pin.modelId) || !pin.effort || !pin.credentialId) {
    return runtimePinProblem(
      pin,
      "pin-incomplete",
      "Choose a provider, model, effort, and connection.",
    );
  }
  const scripted =
    pin.provider === "scripted" && pin.modelId === "scripted" && pin.credentialId === "scripted";
  if (
    !scripted &&
    (!credential || credential.id !== pin.credentialId || credential.provider !== pin.provider)
  ) {
    return runtimePinProblem(
      pin,
      "pin-credential-missing",
      "The pinned connection is missing or disconnected.",
    );
  }
  // Custom IDs are free-form and bound when the bot is edited. A later space
  // default change must not invalidate that saved choice or a run snapshot.
  const entry = listPiCatalog().find(
    (item) => item.provider === pin.provider && item.id === pin.modelId,
  );
  if (!scripted && pin.provider !== "openai-compatible" && !entry) {
    return runtimePinProblem(
      pin,
      "pin-model-unknown",
      "The pinned model is not available on this connection.",
    );
  }
  const effort = ThinkingLevelSchema.safeParse(pin.effort);
  const supported = scripted
    ? ["off"]
    : pin.provider === "openai-compatible"
      ? undefined
      : entry?.thinkingLevels;
  if (!effort.success || (supported && !supported.includes(effort.data))) {
    return runtimePinProblem(
      pin,
      "pin-effort-unsupported",
      "The pinned model does not support this effort.",
    );
  }
  return {
    kind: "resolved",
    pin,
    provider: pin.provider,
    id: pin.modelId!,
    thinkingLevel: effort.data,
    credential,
  };
}

/** Check the concrete adapter model too: custom endpoint capabilities live in its secret. */
export function validateRuntimePin(
  model: AgentRunModel,
  pin: RuntimePin,
): RuntimeProblem | undefined {
  if (model.provider === "scripted" && model.id === "scripted") return undefined;
  if (model.provider === "openai-compatible" && !model.baseUrl) {
    return runtimePinProblem(
      pin,
      "pin-credential-missing",
      "The pinned connection has no endpoint.",
    );
  }
  const concrete = modelsForRequest({ model }, model.provider).getModel(model.provider, model.id);
  if (!concrete)
    return runtimePinProblem(
      pin,
      "pin-model-unknown",
      "The pinned model is not available in this runtime.",
    );
  if (!getSupportedThinkingLevels(concrete).includes(pin.effort as ThinkingLevel)) {
    return runtimePinProblem(
      pin,
      "pin-effort-unsupported",
      "The pinned model does not support this effort.",
    );
  }
  return undefined;
}

export type BotPinFields = {
  allowedModelDestinations?: unknown;
  modelProvider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
  modelCredentialId?: string | null;
  modelPinRevision?: number;
};

export function requestedBotPin(bot: BotPinFields): RuntimePin {
  return {
    provider: bot.modelProvider ?? null,
    modelId: bot.modelId ?? null,
    effort: bot.thinkingLevel ?? null,
    credentialId: bot.modelCredentialId ?? null,
    revision: bot.modelPinRevision ?? 0,
  };
}

export function hasBotPin(bot: BotPinFields | null): boolean {
  return Boolean(
    bot && (bot.modelProvider != null || bot.modelId != null || bot.modelCredentialId != null),
  );
}

export async function credentialForPin(
  prisma: PrismaClient,
  scope: Pick<Actor, "userId" | "spaceId">,
  pin: RuntimePin,
) {
  return pin.provider && pin.credentialId && pin.provider !== "scripted"
    ? findBoundModelCredential(prisma, scope, pin.provider, pin.credentialId)
    : null;
}
