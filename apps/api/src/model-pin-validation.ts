import {
  canBotRun,
  isSerializedModelCredential,
  listOllamaModels,
  listPiCatalog,
  modelCredentialDto,
  nativeRuntimeAvailability,
  ollamaErrorMessage,
  parseModelSecret,
  piModelContextWindow,
  requestedBotPin,
  runtimeComputerLocation,
  selectConfiguredModel,
  showOllamaModel,
  suggestedModelEffort,
} from "@ardurbot/adapters";
import type {
  Actor,
  ComputerMode,
  RuntimeComputerLocation,
  RuntimeKind,
  RuntimePin,
  UpdateBotInput,
} from "@ardurbot/contracts";
import {
  DEFAULT_CONNECTION_CONTEXT_WINDOW,
  failureCategoryMessage,
  nativeRuntimeProviders,
  normalizedThinkingLevel,
  ollamaThink,
  RuntimePinSchema,
  runtimeNames,
  ThinkingLevelSchema,
  validateAntigravityPin,
} from "@ardurbot/contracts";
import { spaceDefaultEffort } from "@ardurbot/core";
import type { Prisma } from "@ardurbot/db";
import {
  findBoundModelCredential,
  findDefaultModelCredential,
  findModelCredential,
  IsolationError,
} from "@ardurbot/db";
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
  policies?: Pick<Parameters<typeof canBotRun>[0], "botPolicy" | "spacePolicy">,
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
    ((input.runtimeKind ?? existing.runtimeKind ?? "pi") !== "hermes" ||
      (input.modelProvider ?? existing.modelProvider) === "ollama") &&
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
  const connectionProblem = canBotRun({
    pin: {
      runtimeKind: runtimeKind as RuntimeKind,
      provider,
      modelId,
      effort: null,
      credentialId: credentialId ?? credential?.id ?? null,
      revision: 0,
    },
    connection: { credential },
  });
  if (connectionProblem) throw new ORPCError("BAD_REQUEST", { message: connectionProblem.reason });
  if (!credential) throw new ORPCError("BAD_REQUEST");
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
        const problem = canBotRun({
          ...policies,
          pin: {
            runtimeKind,
            provider,
            modelId,
            effort: effort === "off" ? "none" : effort,
            credentialId: credential.id,
            revision: 0,
          },
          model: {
            provider,
            id: modelId,
            baseUrl: `${connection.baseUrl}/v1`,
            contextWindow: model.contextWindow,
            maxTokens: Math.max(1, Math.min(4096, Math.floor(model.contextWindow / 4))),
            thinkingLevel: ThinkingLevelSchema.parse(normalizedThinkingLevel(effort)),
          },
        });
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
      const message = ollamaErrorMessage(error);
      const unavailable = [
        "Ollama is not running. Start it and try again.",
        "Could not reach Ollama. Check the server URL and try again.",
        "Ollama took too long. Try again.",
        "Ollama could not complete the request. Try again.",
      ].includes(message);
      // A temporarily unavailable server is not an impossible settings combination.
      throw new ORPCError(unavailable ? "PRECONDITION_FAILED" : "BAD_REQUEST", { message });
    }
  }
  const entry = listPiCatalog().find((item) => item.provider === provider && item.id === modelId);
  if (
    provider === "openai-compatible"
      ? credential.defaultModel !== modelId &&
        !(unchanged && existing.modelCredentialId === credential.id)
      : !entry
  ) {
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
    // Hermes refuses sign-in connections; detect them from the stored secret so
    // editing fails with the same reason a run would.
    const secret = await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: actor.userId, spaceId: null },
    });
    if (!secret)
      throw new ORPCError("BAD_REQUEST", { message: "The pinned connection secret is missing." });
    const plaintext = deps.secrets.load(secret.ciphertext, secret.id);
    const signIn =
      (provider === "anthropic" && isSerializedModelCredential(plaintext)) ||
      parseModelSecret(plaintext).kind === "oauth";
    const problem = canBotRun({
      ...policies,
      pin: { runtimeKind, provider, modelId, effort, credentialId: credential.id, revision: 0 },
      model: {
        provider,
        id: modelId,
        baseUrl: compatible?.baseUrl,
        reasoning: compatible?.reasoning,
        contextWindow:
          compatible?.contextWindow ??
          piModelContextWindow(provider, modelId) ??
          DEFAULT_CONNECTION_CONTEXT_WINDOW,
        maxTokens: compatible?.maxTokens,
        thinkingLevel: ThinkingLevelSchema.parse(effort),
        ...(signIn
          ? {
              oauth: {
                credential: { type: "oauth" as const, access: "", refresh: "", expires: 0 },
              },
            }
          : {}),
      },
    });
    if (problem) throw new ORPCError("BAD_REQUEST", { message: problem.reason });
  }
  if (
    runtimeKind === existing.runtimeKind &&
    provider === existing.modelProvider &&
    modelId === existing.modelId &&
    credential.id === existing.modelCredentialId &&
    effort === existing.thinkingLevel
  )
    return {};
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
  policies?: Pick<Parameters<typeof canBotRun>[0], "botPolicy" | "spacePolicy">,
): Promise<ValidatedModelPinChoice> {
  const checked = RuntimePinSchema.omit({ revision: true }).parse(choice);
  if (
    !checked.provider ||
    !checked.modelId ||
    !checked.credentialId ||
    (checked.effort === null && checked.provider !== "ollama" && checked.provider !== "antigravity")
  )
    throw new ORPCError("BAD_REQUEST", { message: "Choose a model, effort and connection." });
  if (
    checked.runtimeKind === "pi" &&
    checked.provider === "scripted" &&
    checked.modelId === "scripted" &&
    checked.credentialId === "scripted" &&
    checked.effort === "off" &&
    deps.env.agentRuntime === "scripted"
  )
    return {
      runtimeKind: "pi",
      provider: "scripted",
      modelId: "scripted",
      credentialId: "scripted",
      effort: "off",
    };
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
    policies,
  );
  return {
    runtimeKind: checked.runtimeKind,
    provider: update.modelProvider as string,
    modelId: update.modelId as string,
    effort: update.thinkingLevel as string | null,
    credentialId: update.modelCredentialId as string,
  };
}

export type BotRunSettingsContext = {
  botId?: string;
  runtimeExperimental?: boolean;
  computerLocation?: "host" | "sandbox";
  computerMode?: ComputerMode;
  inheritBotPin?: boolean;
};

/** Read the actual destination of a sharing change without creating or moving a computer. */
export async function botRunComputerLocation(
  deps: RouterDeps,
  actor: Actor,
  computer: { kind: string; connectionId?: string | null; spaceId: string; scope?: string } | null,
  botId: string,
  mode?: ComputerMode,
): Promise<RuntimeComputerLocation> {
  const currentMode = computer?.scope === "dedicated" ? "dedicated" : "team";
  const destination =
    mode && mode !== currentMode
      ? mode === "team"
        ? await deps.prisma.computer.findFirst({
            where: { spaceId: actor.spaceId, scope: "team" },
            orderBy: [{ bots: { _count: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
          })
        : await deps.prisma.computer.findUnique({ where: { scopeKey: `bot:${botId}` } })
      : null;
  return runtimeComputerLocation(deps.prisma, destination ?? computer);
}

/** Resolve trusted facts once; forms and save endpoints use the same run admission predicates. */
export async function validateBotCanRun(
  deps: RouterDeps,
  actor: Actor,
  choice: Omit<RuntimePin, "revision">,
  context: BotRunSettingsContext,
): Promise<void> {
  const bot = context.botId
    ? await deps.prisma.bot.findFirst({
        where: {
          id: context.botId,
          userId: actor.userId,
          spaceId: actor.spaceId,
          archivedAt: null,
        },
        include: { computer: true },
      })
    : null;
  if (context.botId && !bot) throw new IsolationError();
  // An existing bot's computer is never supplied by the client.
  const computer: RuntimeComputerLocation = bot
    ? await botRunComputerLocation(deps, actor, bot.computer, bot.id, context.computerMode)
    : { kind: context.computerLocation === "host" ? "desktop" : "docker" };
  if (context.inheritBotPin && !bot) throw new IsolationError();
  let pin: RuntimePin =
    context.inheritBotPin && bot ? requestedBotPin(bot) : { ...choice, revision: 0 };
  const placement = {
    computer,
    experimental: context.runtimeExperimental ?? bot?.runtimeExperimental ?? false,
  };
  const placementProblem = canBotRun({ pin, placement });
  if (placementProblem) throw new ORPCError("BAD_REQUEST", { message: placementProblem.reason });
  const inheritedNewBotDefault =
    !bot && pin.runtimeKind === "pi" && pin.provider === null && pin.modelId === null;
  const unchangedChoice =
    inheritedNewBotDefault ||
    (bot &&
      (context.inheritBotPin ||
        (pin.runtimeKind === bot.runtimeKind &&
          pin.provider === bot.modelProvider &&
          pin.modelId === bot.modelId &&
          pin.credentialId === bot.modelCredentialId &&
          normalizedThinkingLevel(pin.effort) === normalizedThinkingLevel(bot.thinkingLevel))));
  let credential = null;
  if (pin.runtimeKind === "pi" && pin.provider === null && pin.modelId === null) {
    credential = await findDefaultModelCredential(deps.prisma, actor);
    if (!credential?.defaultModel) {
      if (deps.env.agentRuntime === "scripted")
        pin = {
          ...pin,
          provider: "scripted",
          modelId: "scripted",
          credentialId: "scripted",
          effort: "off",
        };
      else
        throw new ORPCError("BAD_REQUEST", {
          message: failureCategoryMessage("connection-missing", {
            runtime: runtimeNames[pin.runtimeKind],
            bot: "this bot",
          }),
        });
    } else {
      const entry = listPiCatalog().find(
        (item) => item.provider === credential!.provider && item.id === credential!.defaultModel,
      );
      let defaultEffort = spaceDefaultEffort(entry?.reasoning, entry?.thinkingLevels);
      if (credential.provider === "openai-compatible" || credential.provider === "ollama") {
        const secret = await deps.prisma.secret.findFirst({
          where: { id: credential.secretId, userId: actor.userId, spaceId: null },
        });
        if (secret) {
          const metadata = modelCredentialDto(
            credential,
            deps.secrets.load(secret.ciphertext, secret.id),
          );
          defaultEffort =
            metadata.thinkingLevel ??
            spaceDefaultEffort(metadata.reasoning, metadata.thinkingLevels);
        }
      }
      pin = {
        ...pin,
        provider: credential.provider,
        modelId: credential.defaultModel,
        credentialId: credential.id,
        effort: pin.effort ?? defaultEffort,
      };
    }
  }
  if (pin.runtimeKind === "pi" || pin.runtimeKind === "hermes") {
    credential ??=
      pin.provider && pin.credentialId
        ? await findBoundModelCredential(deps.prisma, actor, pin.provider, pin.credentialId)
        : null;
    const problem = canBotRun({ pin, connection: { credential } });
    if (problem) throw new ORPCError("BAD_REQUEST", { message: problem.reason });
  }
  const unchangedOllamaPin = pin.provider === "ollama" && unchangedChoice;
  const space = await deps.prisma.space.findUnique({ where: { id: actor.spaceId } });
  const policies = {
    botPolicy: bot?.allowedModelDestinations,
    spacePolicy: space?.allowedModelDestinations,
  };
  let checked: ValidatedModelPinChoice;
  if (
    (pin.runtimeKind === "pi" || pin.runtimeKind === "hermes") &&
    (pin.provider !== "ollama" || unchangedOllamaPin) &&
    (pin.provider !== "scripted" || deps.env.agentRuntime === "scripted")
  ) {
    const selected = selectConfiguredModel({ pin, credential });
    if (selected.kind !== "resolved")
      throw new ORPCError("BAD_REQUEST", { message: selected.reason });
    checked = {
      runtimeKind: pin.runtimeKind,
      provider: selected.provider,
      modelId: selected.id,
      credentialId: pin.credentialId!,
      effort: pin.effort,
    };
  } else {
    checked = await validateModelPinSelection(deps, actor, pin, policies);
  }
  let metadata: ReturnType<typeof modelCredentialDto> | undefined;
  if (credential) {
    const secret = await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: actor.userId, spaceId: null },
    });
    if (!secret)
      throw new ORPCError("BAD_REQUEST", {
        message: failureCategoryMessage("connection-missing", {
          runtime: runtimeNames[pin.runtimeKind],
          bot: "this bot",
        }),
      });
    metadata = modelCredentialDto(credential, deps.secrets.load(secret.ciphertext, secret.id));
  }
  const problem = canBotRun({
    pin: { ...pin, ...checked },
    model: {
      provider: checked.provider,
      id: checked.modelId,
      baseUrl: metadata?.baseUrl,
      reasoning: metadata?.reasoning,
      ...(metadata?.oauth || metadata?.connectionIssue === "api-key-required"
        ? { oauth: { credential: { type: "oauth" as const, access: "", refresh: "", expires: 0 } } }
        : {}),
      contextWindow:
        checked.provider === "openai-compatible"
          ? metadata?.contextWindow
          : (piModelContextWindow(checked.provider, checked.modelId) ?? metadata?.contextWindow),
      maxTokens: metadata?.maxTokens,
      thinkingLevel: ThinkingLevelSchema.parse(normalizedThinkingLevel(checked.effort)),
    },
    botPolicy: bot?.allowedModelDestinations,
    spacePolicy: space?.allowedModelDestinations,
  });
  if (problem) throw new ORPCError("BAD_REQUEST", { message: problem.reason });
}
