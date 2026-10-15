import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type {
  Actor,
  ResolvedPin,
  RuntimeComputerLocation,
  RuntimeKind,
  RuntimePin,
  RuntimeProblem,
  ThinkingLevel,
} from "@ardurbot/contracts";
import {
  failureCategoryMessage,
  HERMES_CONTEXT_LIMIT_MESSAGE,
  HERMES_MINIMUM_CONTEXT_TOKENS,
  normalizedThinkingLevel,
  runtimeNames,
  runtimePinProblem,
  runtimeSupportsLocation,
  ThinkingLevelSchema,
  usableModelId,
} from "@ardurbot/contracts";
import type { findDefaultModelCredential, PrismaClient } from "@ardurbot/db";
import { findBoundModelCredential } from "@ardurbot/db";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  effectiveHermesConfig,
  hermesCompatibility,
  hermesConfigHash,
} from "./hermes-compatibility.js";
import { modelLocalityRefusedBy } from "./model-locality.js";
import { listPiCatalog } from "./pi-models.js";
import { modelsForRequest } from "./pi-runtime.js";

type ModelCredential = Awaited<ReturnType<typeof findDefaultModelCredential>>;

/** Resolves only the requested selection. Suggestions belong to editing, never this path. */
export function selectConfiguredModel(input: {
  pin: RuntimePin;
  credential: ModelCredential;
}): (ResolvedPin & { credential: ModelCredential }) | RuntimeProblem {
  const { pin, credential } = input;
  if (
    !pin.provider ||
    !usableModelId(pin.modelId) ||
    (!pin.effort && pin.provider !== "ollama") ||
    !pin.credentialId
  ) {
    return runtimePinProblem(
      pin,
      "pin-incomplete",
      "Choose a provider, model, effort, and connection.",
    );
  }
  const scripted =
    pin.provider === "scripted" && pin.modelId === "scripted" && pin.credentialId === "scripted";
  const problem = canBotRun({ pin, connection: { credential } });
  if (problem) return problem;
  // Custom IDs are free-form and bound when the bot is edited. A later space
  // default change must not invalidate that saved choice or a run snapshot.
  const entry = listPiCatalog().find(
    (item) => item.provider === pin.provider && item.id === pin.modelId,
  );
  if (!scripted && pin.provider !== "openai-compatible" && pin.provider !== "ollama" && !entry) {
    return runtimePinProblem(
      pin,
      "pin-model-unknown",
      "The pinned model is not available on this connection.",
    );
  }
  const effort = ThinkingLevelSchema.safeParse(
    pin.provider === "ollama" ? normalizedThinkingLevel(pin.effort) : pin.effort,
  );
  const supported = scripted
    ? ["off"]
    : pin.provider === "openai-compatible" || pin.provider === "ollama"
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
  // Run resolution checks Ollama capabilities against a fresh /api/show before admission.
  // Editing an unchanged pin must not probe for capabilities or invent a context limit.
  if (model.provider === "ollama" && model.baseUrl) return undefined;
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
  runtimeKind?: RuntimeKind | string;
  runtimeConfig?: unknown;
};

export function requestedBotPin(bot: BotPinFields): RuntimePin {
  const config =
    bot.runtimeKind === "hermes" ? effectiveHermesConfig(bot.runtimeConfig) : undefined;
  return {
    runtimeKind: (bot.runtimeKind ?? "pi") as RuntimeKind,
    provider: bot.modelProvider ?? null,
    modelId: bot.modelId ?? null,
    effort:
      bot.modelProvider === "ollama" && bot.thinkingLevel === "off"
        ? "none"
        : (bot.thinkingLevel ?? null),
    credentialId: bot.modelCredentialId ?? null,
    revision: bot.modelPinRevision ?? 0,
    ...(config ? { runtimeConfig: config, runtimeConfigHash: hermesConfigHash(config) } : {}),
  };
}

export function hasBotPin(bot: BotPinFields | null): boolean {
  return Boolean(
    bot &&
      ((bot.runtimeKind && bot.runtimeKind !== "pi") ||
        bot.modelProvider != null ||
        bot.modelId != null ||
        bot.modelCredentialId != null),
  );
}

export async function credentialForPin(
  prisma: PrismaClient,
  scope: Pick<Actor, "userId" | "spaceId">,
  pin: RuntimePin,
) {
  return (pin.runtimeKind === "pi" || pin.runtimeKind === "hermes") &&
    pin.provider &&
    pin.credentialId &&
    pin.provider !== "scripted"
    ? findBoundModelCredential(prisma, scope, pin.provider, pin.credentialId)
    : null;
}

/** Pure admission predicates shared by editing and run selection. Facts are supplied by the server. */
export function canBotRun(input: {
  pin: RuntimePin;
  placement?: { computer: RuntimeComputerLocation; experimental: boolean };
  connection?: { credential: { id: string; provider: string } | null };
  model?: AgentRunModel;
  /** Policy edits need only the saved destination, never live capability discovery. */
  destinationModel?: Pick<AgentRunModel, "provider" | "id" | "baseUrl">;
  botPolicy?: unknown;
  spacePolicy?: unknown;
}): RuntimeProblem | undefined {
  const { pin, placement, connection, model } = input;
  const params = { runtime: runtimeNames[pin.runtimeKind], bot: "this bot" };
  if (placement) {
    if (!runtimeSupportsLocation(pin.runtimeKind, placement.computer))
      return runtimePinProblem(
        pin,
        "runtime-unsupported-computer",
        failureCategoryMessage("computer-unsupported", params),
        "computer-unsupported",
      );
    if (pin.runtimeKind !== "pi" && !placement.experimental)
      return runtimePinProblem(
        pin,
        "runtime-unavailable",
        failureCategoryMessage("experimental-off", params),
        "experimental-off",
      );
  }
  if (
    connection &&
    !(
      pin.provider === "scripted" &&
      pin.modelId === "scripted" &&
      pin.credentialId === "scripted"
    ) &&
    (!connection.credential ||
      connection.credential.id !== pin.credentialId ||
      connection.credential.provider !== pin.provider)
  )
    return runtimePinProblem(
      pin,
      "pin-credential-missing",
      failureCategoryMessage("connection-missing", params),
      "connection-missing",
    );
  const destinationModel = model ?? input.destinationModel;
  if (destinationModel) {
    const refusedBy =
      input.botPolicy !== undefined || input.spacePolicy !== undefined
        ? modelLocalityRefusedBy(input.botPolicy, input.spacePolicy, destinationModel)
        : null;
    if (refusedBy) {
      const id = refusedBy === "space" ? "destinations-space" : "destinations-bot";
      return runtimePinProblem(pin, "locality-denied", failureCategoryMessage(id, params), id);
    }
  }
  if (model) {
    if (
      pin.runtimeKind === "hermes" &&
      model.contextWindow !== undefined &&
      model.contextWindow < HERMES_MINIMUM_CONTEXT_TOKENS
    )
      return runtimePinProblem(pin, "runtime-configuration-invalid", HERMES_CONTEXT_LIMIT_MESSAGE);
    if (pin.runtimeKind === "pi" || pin.runtimeKind === "hermes")
      return hermesCompatibility(pin, model) ?? validateRuntimePin(model, pin);
  }
  return undefined;
}
