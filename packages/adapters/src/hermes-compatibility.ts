import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type { RuntimePin, RuntimeProblem } from "@ardurbot/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  HERMES_HOST_MAX_OUTPUT_TOKENS,
  normalizedThinkingLevel,
  runtimePinProblem,
} from "@ardurbot/contracts";
import type { HistoricalHermesRuntimeConfig } from "@ardurbot/contracts/runtime-config";
import {
  legacyHermesRuntimeConfigHash,
  runtimeConfigV2Hash,
} from "@ardurbot/core/node/runtime-config-hash";
import { effectiveHermesRuntimeConfigV2 } from "@ardurbot/core/runtime-config";

export function effectiveHermesConfig(value: unknown) {
  return effectiveHermesRuntimeConfigV2(value);
}

export function hermesConfigHash(config: HistoricalHermesRuntimeConfig): string {
  return config.version === 1 ? legacyHermesRuntimeConfigHash(config) : runtimeConfigV2Hash(config);
}

/** Provider wire observations are requests, not attested provider behavior. */
export function brokerObservedRuntimeInfo(
  effort: string | null,
  reportedModel?: string,
  wireEffort?: string,
) {
  return {
    ...(reportedModel ? { reportedModel } : {}),
    requestedEffort: normalizedThinkingLevel(effort),
    ...(wireEffort ? { wireEffort } : {}),
    effortMappingVersion: "broker-chat-completions-v1",
  };
}

/** One admission rule for editing and run resolution; only qualified compatible endpoints enter M1. */
export function hermesCompatibility(
  pin: RuntimePin,
  model: Pick<
    AgentRunModel,
    | "provider"
    | "id"
    | "apiKey"
    | "baseUrl"
    | "oauth"
    | "contextWindow"
    | "maxTokens"
    | "thinkingLevel"
  >,
): RuntimeProblem | undefined {
  if (pin.runtimeKind !== "hermes") return undefined;
  if (
    !pin.credentialId ||
    pin.credentialId.startsWith("native:") ||
    pin.provider !== model.provider ||
    pin.modelId !== model.id
  )
    return runtimePinProblem(pin, "pin-incomplete", "Choose a connected model for Hermes.");
  if (!["openai-compatible", "ollama"].includes(model.provider) || model.oauth || !model.baseUrl)
    return runtimePinProblem(
      pin,
      "runtime-unsupported-protocol",
      "Hermes needs a Chat Completions connection with a direct endpoint.",
    );
  if (
    !Number.isSafeInteger(model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW) ||
    !Number.isSafeInteger(model.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS) ||
    (model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW) <= 0 ||
    (model.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS) <= 0 ||
    (model.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS) > HERMES_HOST_MAX_OUTPUT_TOKENS
  )
    return runtimePinProblem(
      pin,
      "runtime-configuration-invalid",
      "This connection needs bounded context and output limits.",
    );
  if (normalizedThinkingLevel(pin.effort) !== normalizedThinkingLevel(model.thinkingLevel))
    return runtimePinProblem(
      pin,
      "pin-effort-unsupported",
      "This connection cannot honor the pinned effort.",
    );
  return undefined;
}
