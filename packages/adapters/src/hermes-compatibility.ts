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
import { piKeyBasedCatalogModel } from "./pi-models.js";

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
  // Sign-in (OAuth/subscription) connections never back Hermes: vendors reserve
  // them for their own apps. API-key connections go through the broker.
  if (model.oauth || model.provider === "openai-codex")
    return runtimePinProblem(
      pin,
      "runtime-unsupported-protocol",
      model.provider === "anthropic"
        ? "Claude subscriptions only work in Anthropic's own apps; add an Anthropic API key to use Claude with Hermes."
        : model.provider === "openai-codex"
          ? "ChatGPT sign-ins only work inside Codex; add an OpenAI API key to use GPT models with Hermes."
          : "Add an API key connection to use this provider with Hermes.",
    );
  // Custom endpoints pass Chat Completions through to their direct URL; every
  // other key-based connection is translated through Ardur's provider layer,
  // which needs a registry model served by an API-key provider.
  if (model.provider === "openai-compatible" || model.provider === "ollama") {
    if (!model.baseUrl)
      return runtimePinProblem(
        pin,
        "runtime-unsupported-protocol",
        "This connection cannot run Hermes.",
      );
  } else if (!piKeyBasedCatalogModel(model.provider, model.id)) {
    return runtimePinProblem(
      pin,
      "runtime-unsupported-protocol",
      "This connection cannot run Hermes.",
    );
  }
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
