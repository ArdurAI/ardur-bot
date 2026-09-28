import { createHash } from "node:crypto";
import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type { HermesRuntimeConfig, RuntimePin, RuntimeProblem } from "@ardurbot/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  HERMES_HOST_MAX_OUTPUT_TOKENS,
  HERMES_RUNTIME_DEFAULTS,
  HermesRuntimeConfigSchema,
  normalizedThinkingLevel,
  runtimePinProblem,
} from "@ardurbot/contracts";

export function effectiveHermesConfig(value: unknown): HermesRuntimeConfig {
  return value == null ? HERMES_RUNTIME_DEFAULTS : HermesRuntimeConfigSchema.parse(value);
}

export function hermesConfigHash(config: HermesRuntimeConfig): string {
  // Historical pins retain the exact B11 ordered-array identity.
  return createHash("sha256")
    .update(JSON.stringify([config.version, config.maxProviderRequests, config.timeoutMs]))
    .digest("hex");
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
