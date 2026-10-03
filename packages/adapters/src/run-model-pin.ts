import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type {
  Actor,
  ResolvedPin,
  RuntimePin,
  RuntimeProblem,
  ThinkingLevel,
} from "@ardurbot/contracts";
import {
  antigravityEffortForModel,
  failureCategoryMessage,
  nativeRuntimeProviders,
  RuntimePinError,
  RuntimePinSchema,
  resolveModelContextWindow,
  runtimePinProblem,
  ThinkingLevelSchema,
} from "@ardurbot/contracts";
import { inheritedOllamaEffort, spaceDefaultEffort } from "@ardurbot/core";
import {
  effectiveRuntimeConfigHash,
  validateHermesExecutionEnvelope,
} from "@ardurbot/core/node/runtime-config-hash";
import { migrateHermesRuntimeConfig } from "@ardurbot/core/runtime-config";
import type { findDefaultModelCredential, PrismaClient } from "@ardurbot/db";
import { findDefaultModelCredential as findSpaceDefault } from "@ardurbot/db";
import { compileHermesRuntimeConfig } from "@ardurbot/host-runtime/runtimes/hermes-config";

import { hermesCompatibility, hermesConfigHash } from "./hermes-compatibility.js";
import { modelLocalityRefusedBy } from "./model-locality.js";
import { listPiCatalog, piModelContextWindow } from "./pi-models.js";
import { AnthropicOAuthUnavailableError } from "./pi-oauth.js";
import { catalogModels } from "./pi-runtime.js";
import type { BotPinFields } from "./pin-resolution.js";
import {
  credentialForPin,
  hasBotPin,
  requestedBotPin,
  selectConfiguredModel,
  validateRuntimePin,
} from "./pin-resolution.js";

type Credential = Awaited<ReturnType<typeof findDefaultModelCredential>>;
export type ResolvedRunPin = AgentRunModel & ResolvedPin;

/**
 * The locality refusal as its failure-category id and sentence. The registry does not know
 * the bot's name, so {bot} is filled with "this bot"; the apps, which do, replace it when
 * they translate the category.
 */
function localityProblem(pin: RuntimePin, refusedBy: "bot" | "space" | null): RuntimeProblem {
  const id = refusedBy === "space" ? "destinations-space" : "destinations-bot";
  return runtimePinProblem(
    pin,
    "locality-denied",
    failureCategoryMessage(id, { bot: "this bot" }),
    id,
  );
}

export async function resolveRunModelPin(input: {
  prisma: PrismaClient;
  scope: Pick<Actor, "userId" | "spaceId">;
  bot: BotPinFields | null;
  snapshot?: unknown;
  scripted: boolean;
  /** True only before the run pin is first captured, including explicit group choices. */
  newAdmission?: boolean;
  /** Output allowance fixed when a delegated Hermes pin is admitted. */
  maxOutputTokens?: number;
  loadKey: (
    credential: Credential,
    pin: RuntimePin,
    selectDefaultEffort?: boolean,
  ) => Promise<AgentRunModel>;
}): Promise<ResolvedRunPin | RuntimeProblem> {
  const { bot } = input;
  let pin: RuntimePin;
  let credential: Credential = null;
  let loadedModel: AgentRunModel | undefined;
  if (input.snapshot != null) {
    const parsed = RuntimePinSchema.safeParse(input.snapshot);
    if (!parsed.success) {
      const recorded =
        typeof input.snapshot === "object" ? (input.snapshot as Record<string, unknown>) : {};
      const field = (key: string) => (typeof recorded[key] === "string" ? recorded[key] : null);
      return runtimePinProblem(
        {
          runtimeKind: "pi",
          provider: field("provider"),
          modelId: field("modelId"),
          effort: field("effort"),
          credentialId: field("credentialId"),
          revision:
            typeof recorded.revision === "number" &&
            Number.isInteger(recorded.revision) &&
            recorded.revision >= 0
              ? recorded.revision
              : 0,
        },
        "pin-incomplete",
        "The run's recorded pin is incomplete.",
      );
    }
    pin = parsed.data;
    if (input.newAdmission && pin.runtimeKind === "hermes" && pin.runtimeConfig?.version === 1) {
      if (pin.runtimeConfigHash !== hermesConfigHash(pin.runtimeConfig))
        return runtimePinProblem(
          pin,
          "runtime-configuration-invalid",
          "The recorded Hermes limits are invalid.",
        );
      const runtimeConfig = migrateHermesRuntimeConfig(pin.runtimeConfig);
      pin = { ...pin, runtimeConfig, runtimeConfigHash: hermesConfigHash(runtimeConfig) };
    }
  } else if (hasBotPin(bot)) {
    pin = requestedBotPin(bot!);
  } else {
    // Compatibility for bots displaying Space default: capture that one selection once.
    // No settings, deployment, catalog-first, or other-connection fallback is allowed.
    credential = await findSpaceDefault(input.prisma, input.scope);
    const entry = listPiCatalog().find(
      (item) => item.provider === credential?.provider && item.id === credential.defaultModel,
    );
    pin = {
      runtimeKind: "pi",
      provider: credential?.provider ?? (input.scripted ? "scripted" : null),
      modelId: credential?.defaultModel ?? (input.scripted ? "scripted" : null),
      effort:
        credential?.provider === "ollama" && bot?.thinkingLevel === "off"
          ? inheritedOllamaEffort(bot.thinkingLevel, entry?.reasoning)
          : (bot?.thinkingLevel ??
            spaceDefaultEffort(entry?.reasoning ?? false, entry?.thinkingLevels)),
      credentialId: credential?.id ?? (input.scripted ? "scripted" : null),
      revision: bot?.modelPinRevision ?? 0,
    };
    // A custom space default displays the effort stored with its connection.
    if (
      (credential?.provider === "openai-compatible" || credential?.provider === "ollama") &&
      !bot?.thinkingLevel
    ) {
      try {
        loadedModel = await input.loadKey(credential, pin, credential.provider === "ollama");
        pin.effort =
          credential.provider === "ollama"
            ? inheritedOllamaEffort(null, loadedModel.reasoning)
            : (loadedModel.thinkingLevel ?? (loadedModel.reasoning ? "medium" : "off"));
      } catch (error) {
        if (error instanceof RuntimePinError) return error.problem;
        throw error;
      }
    }
  }
  if (pin.runtimeKind !== "pi" && pin.runtimeKind !== "hermes") {
    if (!(pin.runtimeKind in nativeRuntimeProviders))
      return runtimePinProblem(
        pin,
        "runtime-unavailable",
        "The pinned runtime is unavailable — change the pin.",
      );
    const provider = nativeRuntimeProviders[pin.runtimeKind as keyof typeof nativeRuntimeProviders];
    if (pin.credentialId && pin.credentialId !== `native:${pin.runtimeKind}`)
      return runtimePinProblem(
        pin,
        "runtime-unavailable",
        "Native runtimes use their own sign-in. Remove the pinned connection or change the runtime.",
      );
    if (
      pin.provider !== provider ||
      !pin.modelId ||
      (pin.runtimeKind !== "antigravity" && !pin.effort) ||
      pin.credentialId !== `native:${pin.runtimeKind}`
    ) {
      return runtimePinProblem(
        pin,
        "pin-incomplete",
        "Choose a model, effort, and runtime sign-in.",
      );
    }
    const expected =
      pin.runtimeKind === "antigravity" ? antigravityEffortForModel(pin.modelId) : undefined;
    const effort = ThinkingLevelSchema.safeParse(pin.effort);
    if (
      pin.runtimeKind === "antigravity"
        ? expected === undefined || (pin.effort !== null && pin.effort !== expected)
        : !effort.success
    )
      return runtimePinProblem(
        pin,
        "pin-effort-unsupported",
        "The pinned effort is unavailable in this runtime.",
      );
    const space = await input.prisma.space.findUnique({ where: { id: input.scope.spaceId } });
    {
      const refusedBy = modelLocalityRefusedBy(
        bot?.allowedModelDestinations,
        space?.allowedModelDestinations,
        {
          provider,
          id: pin.modelId,
        } as AgentRunModel,
      );
      if (refusedBy) return localityProblem(pin, refusedBy);
    }
    return {
      kind: "resolved",
      pin,
      runtimePin: pin,
      provider,
      id: pin.modelId,
      thinkingLevel:
        pin.runtimeKind === "antigravity" ? (pin.effort as ThinkingLevel | null) : effort.data!,
    };
  }
  if (
    pin.runtimeKind === "hermes" &&
    (!pin.runtimeConfig || pin.runtimeConfigHash !== hermesConfigHash(pin.runtimeConfig))
  )
    return runtimePinProblem(
      pin,
      "runtime-configuration-invalid",
      "The recorded Hermes limits are invalid.",
    );
  if (
    pin.runtimeKind === "hermes" &&
    input.snapshot != null &&
    !input.newAdmission &&
    pin.runtimeConfig?.version === 2 &&
    !pin.effectiveRuntimeConfig
  )
    return runtimePinProblem(
      pin,
      "runtime-configuration-invalid",
      "This run uses an older runtime configuration. Start a new run.",
    );
  if (input.snapshot != null || hasBotPin(bot))
    credential = await credentialForPin(input.prisma, input.scope, pin);
  if (pin.provider === "scripted" && !input.scripted)
    return runtimePinProblem(
      pin,
      "pin-model-unknown",
      "The pinned model is not available in this runtime.",
    );
  const selected = selectConfiguredModel({ pin, credential });
  if (selected.kind === "problem") return selected;
  try {
    if (input.snapshot == null && pin.provider === "ollama" && bot?.thinkingLevel === "off") {
      const discovered = await input.loadKey(credential, pin, true);
      pin.effort = inheritedOllamaEffort(bot.thinkingLevel, discovered.reasoning);
    }
    const model = loadedModel ?? (await input.loadKey(credential, pin));
    // Key-based catalog providers keep their capabilities in the registry, not
    // in the connection secret; Hermes sizes its manifest and broker from them.
    const translatedHermes =
      pin.runtimeKind === "hermes" &&
      pin.provider !== "openai-compatible" &&
      pin.provider !== "ollama" &&
      pin.provider !== "scripted";
    const concrete = translatedHermes
      ? catalogModels().getModel(model.provider, model.id)
      : undefined;
    // What the connection can produce today: its own declared limit, or the registry's for a
    // key-based catalog connection, whose secret declares none.
    const availableMaxTokens = model.maxTokens ?? concrete?.maxTokens ?? 4_096;
    const resolved = {
      ...model,
      ...(model.contextWindow !== undefined && model.contextWindowSource
        ? { contextWindow: model.contextWindow, contextWindowSource: model.contextWindowSource }
        : resolveModelContextWindow(
            model.contextWindow,
            concrete?.contextWindow ?? piModelContextWindow(model.provider, model.id),
          )),
      ...(translatedHermes
        ? {
            reasoning: model.reasoning ?? concrete?.reasoning,
            acceptsImages: concrete
              ? concrete.input.includes("image")
              : Boolean(model.acceptsImages),
          }
        : {}),
      ...(pin.runtimeKind === "hermes"
        ? {
            maxTokens: Math.min(availableMaxTokens, input.maxOutputTokens ?? 65_536),
          }
        : {}),
      runtimePin: pin,
      thinkingLevel: selected.thinkingLevel,
    };
    const space = await input.prisma.space.findUnique({ where: { id: input.scope.spaceId } });
    {
      const refusedBy = modelLocalityRefusedBy(
        bot?.allowedModelDestinations,
        space?.allowedModelDestinations,
        resolved,
      );
      if (refusedBy) return localityProblem(pin, refusedBy);
    }
    const problem = validateRuntimePin(resolved, pin);
    const compatibilityProblem = problem ?? hermesCompatibility(pin, resolved);
    if (compatibilityProblem) return compatibilityProblem;

    if (
      pin.runtimeKind === "hermes" &&
      input.newAdmission &&
      pin.runtimeConfig?.version === 2 &&
      !pin.effectiveRuntimeConfig
    ) {
      const document = pin.runtimeConfig;
      const compiled = compileHermesRuntimeConfig(document, {
        id: resolved.id,
        contextWindow: resolved.contextWindow!,
        maxTokens: resolved.maxTokens!,
        reasoning: resolved.reasoning ?? false,
        acceptsImages: resolved.acceptsImages ?? false,
        thinkingLevel: ThinkingLevelSchema.parse(resolved.thinkingLevel ?? "off"),
      });
      pin.effectiveRuntimeConfig = compiled.manifest;
      pin.effectiveRuntimeConfigHash = effectiveRuntimeConfigHash(compiled.manifest);
    }
    if (pin.runtimeKind === "hermes" && pin.effectiveRuntimeConfig) {
      const captured = pin.effectiveRuntimeConfig.model;
      if (
        captured.id !== resolved.id ||
        captured.contextWindow !== resolved.contextWindow ||
        availableMaxTokens < captured.maxTokens ||
        captured.reasoning !== (resolved.reasoning ?? false) ||
        captured.acceptsImages !== (resolved.acceptsImages ?? false) ||
        captured.thinkingLevel !== ThinkingLevelSchema.parse(resolved.thinkingLevel ?? "off")
      )
        return runtimePinProblem(
          pin,
          "runtime-configuration-invalid",
          "The connection's model capabilities changed. Start a new run.",
        );
      resolved.maxTokens = captured.maxTokens;
      validateHermesExecutionEnvelope({
        runtimeKind: "hermes",
        runtimeConfig: pin.runtimeConfig,
        runtimeConfigHash: pin.runtimeConfigHash,
        effectiveRuntimeConfig: pin.effectiveRuntimeConfig,
        effectiveRuntimeConfigHash: pin.effectiveRuntimeConfigHash,
      });
    }

    return { ...resolved, kind: "resolved", pin };
  } catch (error) {
    if (error instanceof AnthropicOAuthUnavailableError) {
      return runtimePinProblem(pin, "pin-credential-missing", error.message);
    }
    if (error instanceof RuntimePinError) return { ...error.problem, pin };
    throw error;
  }
}
