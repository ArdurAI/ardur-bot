import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type { Actor, ResolvedPin, RuntimePin, RuntimeProblem } from "@ardurbot/contracts";
import {
  MODEL_LOCALITY_DENIED_MESSAGE,
  RuntimePinError,
  RuntimePinSchema,
  runtimePinProblem,
  ThinkingLevelSchema,
} from "@ardurbot/contracts";
import { spaceDefaultEffort } from "@ardurbot/core";
import type { findDefaultModelCredential, PrismaClient } from "@ardurbot/db";
import { findDefaultModelCredential as findSpaceDefault } from "@ardurbot/db";
import { modelLocalityAllowed } from "./model-locality.js";
import { listPiCatalog } from "./pi-models.js";
import { AnthropicOAuthUnavailableError } from "./pi-oauth.js";
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

export async function resolveRunModelPin(input: {
  prisma: PrismaClient;
  scope: Pick<Actor, "userId" | "spaceId">;
  bot: BotPinFields | null;
  snapshot?: unknown;
  scripted: boolean;
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
          ? "none"
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
            ? loadedModel.reasoning
              ? "medium"
              : null
            : (loadedModel.thinkingLevel ?? (loadedModel.reasoning ? "medium" : "off"));
      } catch (error) {
        if (error instanceof RuntimePinError) return error.problem;
        throw error;
      }
    }
  }
  if (pin.runtimeKind !== "pi") {
    if (pin.runtimeKind !== "claude-code" && pin.runtimeKind !== "codex-app-server")
      return runtimePinProblem(
        pin,
        "runtime-unavailable",
        "The pinned runtime is unavailable — change the pin.",
      );
    const provider = pin.runtimeKind === "claude-code" ? "anthropic" : "openai-codex";
    if (pin.credentialId && pin.credentialId !== `native:${pin.runtimeKind}`)
      return runtimePinProblem(
        pin,
        "runtime-unavailable",
        "Native runtimes use their own sign-in. Remove the pinned connection or change the runtime.",
      );
    if (
      pin.provider !== provider ||
      !pin.modelId ||
      !pin.effort ||
      pin.credentialId !== `native:${pin.runtimeKind}`
    ) {
      return runtimePinProblem(
        pin,
        "pin-incomplete",
        "Choose a model, effort, and runtime sign-in.",
      );
    }
    const effort = ThinkingLevelSchema.safeParse(pin.effort);
    if (!effort.success)
      return runtimePinProblem(
        pin,
        "pin-effort-unsupported",
        "The pinned effort is unavailable in this runtime.",
      );
    return {
      kind: "resolved",
      pin,
      runtimePin: pin,
      provider,
      id: pin.modelId,
      thinkingLevel: effort.data,
    };
  }
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
    const model = loadedModel ?? (await input.loadKey(credential, pin));
    const resolved = { ...model, runtimePin: pin, thinkingLevel: selected.thinkingLevel };
    const space = await input.prisma.space.findUnique({ where: { id: input.scope.spaceId } });
    if (
      !modelLocalityAllowed(
        [bot?.allowedModelDestinations, space?.allowedModelDestinations],
        resolved,
      )
    )
      return runtimePinProblem(pin, "locality-denied", MODEL_LOCALITY_DENIED_MESSAGE);
    const problem = validateRuntimePin(resolved, pin);
    return problem ?? { ...resolved, kind: "resolved", pin };
  } catch (error) {
    if (error instanceof AnthropicOAuthUnavailableError) {
      return runtimePinProblem(pin, "pin-credential-missing", error.message);
    }
    if (error instanceof RuntimePinError) return error.problem;
    throw error;
  }
}
