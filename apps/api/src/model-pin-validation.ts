import {
  hermesCompatibility,
  listOllamaModels,
  listPiCatalog,
  modelCredentialDto,
  nativeRuntimeAvailability,
  ollamaErrorMessage,
  parseModelSecret,
  showOllamaModel,
  suggestedModelEffort,
} from "@ardurbot/adapters";
import type { Actor, RuntimeKind, RuntimePin, UpdateBotInput } from "@ardurbot/contracts";
import {
  nativeRuntimeProviders,
  normalizedThinkingLevel,
  ollamaThink,
  RuntimePinSchema,
  ThinkingLevelSchema,
  validateAntigravityPin,
} from "@ardurbot/contracts";
import type { Prisma } from "@ardurbot/db";
import { findBoundModelCredential, findModelCredential } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";

/** Complete and bind a user's choice at edit time. Runtime never makes these choices. */
export async function normalizeModelPinUpdate(
  deps: RouterDeps,
  actor: Actor,
  existing: {
    modelProvider: string | null;
    modelId: string | null;
    thinkingLevel: string | null;
    modelCredentialId: string | null;
    runtimeKind?: string;
  },
  input: ReturnType<typeof UpdateBotInput.parse>,
): Promise<Prisma.BotUpdateInput> {
  if (
    input.runtimeKind === undefined &&
    input.modelProvider === undefined &&
    input.modelId === undefined &&
    input.thinkingLevel === undefined &&
    input.modelCredentialId === undefined
  )
    return {};
  if (
    (input.runtimeKind === undefined || input.runtimeKind === (existing.runtimeKind ?? "pi")) &&
    (input.modelProvider === undefined || input.modelProvider === existing.modelProvider) &&
    (input.modelId === undefined || input.modelId === existing.modelId) &&
    (input.thinkingLevel === undefined || input.thinkingLevel === existing.thinkingLevel) &&
    (input.modelCredentialId === undefined ||
      input.modelCredentialId === existing.modelCredentialId)
  )
    return {};
  const provider = input.modelProvider === undefined ? existing.modelProvider : input.modelProvider;
  const modelId = input.modelId === undefined ? existing.modelId : input.modelId;
  const runtimeKind = input.runtimeKind ?? existing.runtimeKind ?? "pi";
  if (runtimeKind !== "pi" && runtimeKind !== "hermes") {
    if (!(runtimeKind in nativeRuntimeProviders))
      throw new ORPCError("BAD_REQUEST", { message: "Choose a runtime." });
    const nativeProvider =
      nativeRuntimeProviders[runtimeKind as keyof typeof nativeRuntimeProviders];
    if (input.modelCredentialId && input.modelCredentialId !== `native:${runtimeKind}`)
      throw new ORPCError("BAD_REQUEST", {
        message:
          "Native runtimes use their own sign-in. Remove the pinned connection or change the runtime.",
      });
    const effort = input.thinkingLevel === undefined ? existing.thinkingLevel : input.thinkingLevel;
    if (provider !== nativeProvider || !modelId || (runtimeKind !== "antigravity" && !effort))
      throw new ORPCError("BAD_REQUEST", {
        message: "Choose a model and effort for this runtime.",
      });
    const availability = await nativeRuntimeAvailability(runtimeKind as RuntimeKind);
    const model = availability.models.find((entry) => entry.id === modelId);
    if (runtimeKind === "antigravity") {
      const problem = validateAntigravityPin(
        { runtimeKind, provider, modelId, effort, credentialId: "native:antigravity", revision: 0 },
        availability.models,
      );
      if (problem) throw new ORPCError("BAD_REQUEST", { message: problem.reason });
    } else if (availability.available && !model?.efforts.includes(effort!))
      throw new ORPCError("BAD_REQUEST", {
        message: "This runtime cannot honor that model and effort.",
      });
    return {
      runtimeKind,
      modelProvider: provider,
      modelId,
      thinkingLevel: effort,
      modelCredentialId: `native:${runtimeKind}`,
      modelPinRevision: { increment: 1 },
    };
  }
  if (!provider && !modelId && runtimeKind === "hermes")
    throw new ORPCError("BAD_REQUEST", { message: "Choose a connected model for Hermes." });
  if (!provider && !modelId)
    return {
      runtimeKind: "pi",
      modelProvider: null,
      modelId: null,
      modelCredentialId: null,
      thinkingLevel: input.thinkingLevel,
      modelPinRevision: { increment: 1 },
    };
  if (!provider || !modelId)
    throw new ORPCError("BAD_REQUEST", { message: "Choose a provider and model." });
  const unchanged = provider === existing.modelProvider && modelId === existing.modelId;
  const credentialId = input.modelCredentialId ?? (unchanged ? existing.modelCredentialId : null);
  if (runtimeKind === "hermes" && (!credentialId || credentialId.startsWith("native:")))
    throw new ORPCError("BAD_REQUEST", { message: "Choose a connected model for Hermes." });
  if (unchanged && !credentialId)
    throw new ORPCError("BAD_REQUEST", { message: "Choose the connection to use." });
  const credential = credentialId
    ? await findBoundModelCredential(deps.prisma, actor, provider, credentialId)
    : runtimeKind === "hermes"
      ? null
      : await findModelCredential(deps.prisma, actor, provider, modelId);
  if (!credential)
    throw new ORPCError("BAD_REQUEST", { message: "Connect that model provider first" });
  if (provider === "ollama") {
    const secret = await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: actor.userId, spaceId: null },
    });
    if (!secret) throw new ORPCError("BAD_REQUEST", { message: "Connect Ollama first." });
    const connection = parseModelSecret(deps.secrets.load(secret.ciphertext, secret.id));
    if (connection.kind !== "openai_compatible")
      throw new ORPCError("BAD_REQUEST", { message: "Connect Ollama again." });
    try {
      const models = await listOllamaModels(connection.baseUrl);
      if (!models.some((model) => model.name === modelId))
        throw new Error("This Ollama model is not installed. Change pin.");
      const model = await showOllamaModel(connection.baseUrl, modelId);
      if (!model.contextWindow)
        throw new Error("Ollama did not report this model's context length. Change pin.");
      const effort = model.reasoning
        ? (input.thinkingLevel ?? (unchanged ? existing.thinkingLevel : null) ?? "medium")
        : null;
      ollamaThink(effort, model);
      if (runtimeKind === "hermes") {
        const problem = hermesCompatibility(
          {
            runtimeKind,
            provider,
            modelId,
            effort: effort === "off" ? "none" : effort,
            credentialId: credential.id,
            revision: 0,
          },
          {
            provider,
            id: modelId,
            baseUrl: `${connection.baseUrl}/v1`,
            contextWindow: model.contextWindow,
            maxTokens: Math.max(1, Math.min(4096, Math.floor(model.contextWindow / 4))),
            thinkingLevel: ThinkingLevelSchema.parse(normalizedThinkingLevel(effort)),
          },
        );
        if (problem) throw new ORPCError("BAD_REQUEST", { message: problem.reason });
      }
      return {
        runtimeKind,
        modelProvider: provider,
        modelId,
        modelCredentialId: credential.id,
        thinkingLevel: effort,
        modelPinRevision: { increment: 1 },
      };
    } catch (error) {
      throw new ORPCError("BAD_REQUEST", {
        message: ollamaErrorMessage(error),
      });
    }
  }
  const entry = listPiCatalog().find((item) => item.provider === provider && item.id === modelId);
  if (provider === "openai-compatible" ? credential.defaultModel !== modelId : !entry) {
    throw new ORPCError("BAD_REQUEST", { message: "Unknown model for that provider" });
  }
  let levels = entry?.thinkingLevels ?? ["off" as const];
  let suggested = suggestedModelEffort(levels);
  let compatible: ReturnType<typeof modelCredentialDto> | undefined;
  if (provider === "openai-compatible") {
    const secret = await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: actor.userId, spaceId: null },
    });
    if (!secret)
      throw new ORPCError("BAD_REQUEST", { message: "Connect that model provider first" });
    const metadata = modelCredentialDto(
      credential,
      deps.secrets.load(secret.ciphertext, secret.id),
    );
    compatible = metadata;
    levels = metadata.thinkingLevels ?? ["off"];
    suggested = metadata.thinkingLevel ?? suggestedModelEffort(levels);
  }
  const effort =
    input.thinkingLevel === undefined && unchanged
      ? (existing.thinkingLevel ?? suggested)
      : (input.thinkingLevel ?? suggested);
  if (!levels.includes(effort as (typeof levels)[number]))
    throw new ORPCError("BAD_REQUEST", {
      message: `Thinking level must be one of: ${levels.join(", ")}`,
    });
  if (runtimeKind === "hermes") {
    const problem = hermesCompatibility(
      { runtimeKind, provider, modelId, effort, credentialId: credential.id, revision: 0 },
      {
        provider,
        id: modelId,
        baseUrl: compatible?.baseUrl,
        contextWindow: compatible?.contextWindow,
        maxTokens: compatible?.maxTokens,
        thinkingLevel: ThinkingLevelSchema.parse(effort),
      },
    );
    if (problem) throw new ORPCError("BAD_REQUEST", { message: problem.reason });
  }
  return {
    runtimeKind,
    modelProvider: provider,
    modelId,
    modelCredentialId: credential.id,
    thinkingLevel: effort,
    modelPinRevision: { increment: 1 },
  };
}

/** A validated choice with every required field bound: the shape setReviewer accepts. */
export type ValidatedModelPinChoice = {
  runtimeKind: RuntimeKind;
  provider: string;
  modelId: string;
  credentialId: string;
  effort: string | null;
};

/** Share the bot editor's catalog, credential, custom endpoint, effort and native checks. */
export async function validateModelPinSelection(
  deps: RouterDeps,
  actor: Actor,
  choice: Omit<RuntimePin, "revision">,
): Promise<ValidatedModelPinChoice> {
  const checked = RuntimePinSchema.omit({ revision: true }).parse(choice);
  if (
    !checked.provider ||
    !checked.modelId ||
    !checked.credentialId ||
    (checked.effort === null && checked.provider !== "ollama" && checked.provider !== "antigravity")
  )
    throw new ORPCError("BAD_REQUEST", { message: "Choose a model, effort and connection." });
  const update = await normalizeModelPinUpdate(
    deps,
    actor,
    {
      runtimeKind: "pi",
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      modelCredentialId: null,
    },
    {
      botId: "validation",
      runtimeKind: checked.runtimeKind,
      modelProvider: checked.provider,
      modelId: checked.modelId,
      thinkingLevel: checked.effort === null ? null : ThinkingLevelSchema.parse(checked.effort),
      modelCredentialId: checked.credentialId,
    },
  );
  return {
    runtimeKind: checked.runtimeKind,
    provider: update.modelProvider as string,
    modelId: update.modelId as string,
    effort: update.thinkingLevel as string | null,
    credentialId: update.modelCredentialId as string,
  };
}
