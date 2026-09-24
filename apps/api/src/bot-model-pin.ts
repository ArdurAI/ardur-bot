import {
  listOllamaModels,
  listPiCatalog,
  modelCredentialDto,
  nativeRuntimeAvailability,
  ollamaErrorMessage,
  parseModelSecret,
  showOllamaModel,
  suggestedModelEffort,
} from "@ardurbot/adapters";
import type { Actor, UpdateBotInput } from "@ardurbot/contracts";
import { ollamaThink } from "@ardurbot/contracts";
import type { Prisma } from "@ardurbot/db";
import { findBoundModelCredential, findModelCredential } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";

/** Complete and bind a user's choice at edit time. Runtime never makes these choices. */
export async function botModelPinUpdate(
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
  if (runtimeKind !== "pi") {
    if (runtimeKind !== "claude-code" && runtimeKind !== "codex-app-server")
      throw new ORPCError("BAD_REQUEST", { message: "Choose a runtime." });
    const nativeProvider = runtimeKind === "claude-code" ? "anthropic" : "openai-codex";
    if (input.modelCredentialId && input.modelCredentialId !== `native:${runtimeKind}`)
      throw new ORPCError("BAD_REQUEST", {
        message:
          "Native runtimes use their own sign-in. Remove the pinned connection or change the runtime.",
      });
    const effort = input.thinkingLevel ?? existing.thinkingLevel;
    if (provider !== nativeProvider || !modelId || !effort)
      throw new ORPCError("BAD_REQUEST", {
        message: "Choose a model and effort for this runtime.",
      });
    const availability = await nativeRuntimeAvailability(runtimeKind);
    const model = availability.models.find((entry) => entry.id === modelId);
    if (availability.available && !model?.efforts.includes(effort))
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
  if (unchanged && !credentialId)
    throw new ORPCError("BAD_REQUEST", { message: "Choose the connection to use." });
  const credential = credentialId
    ? await findBoundModelCredential(deps.prisma, actor, provider, credentialId)
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
      return {
        runtimeKind: "pi",
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
  return {
    runtimeKind: "pi",
    modelProvider: provider,
    modelId,
    modelCredentialId: credential.id,
    thinkingLevel: effort,
    modelPinRevision: { increment: 1 },
  };
}
