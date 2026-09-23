import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type { Actor, ResolvedPin, RuntimePin, RuntimeProblem } from "@ardurbot/contracts";
import { RuntimePinError, RuntimePinSchema, runtimePinProblem } from "@ardurbot/contracts";
import { spaceDefaultEffort } from "@ardurbot/core";
import type { findDefaultModelCredential, PrismaClient } from "@ardurbot/db";
import { findDefaultModelCredential as findSpaceDefault } from "@ardurbot/db";
import { listPiCatalog } from "./pi-models.js";
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
  loadKey: (credential: Credential, pin: RuntimePin) => Promise<AgentRunModel>;
}): Promise<ResolvedRunPin | RuntimeProblem> {
  const { bot } = input;
  let pin: RuntimePin;
  let credential: Credential;
  let loadedModel: AgentRunModel | undefined;
  if (input.snapshot != null) {
    const parsed = RuntimePinSchema.safeParse(input.snapshot);
    if (!parsed.success) {
      const recorded =
        typeof input.snapshot === "object" ? (input.snapshot as Record<string, unknown>) : {};
      const field = (key: string) => (typeof recorded[key] === "string" ? recorded[key] : null);
      return runtimePinProblem(
        {
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
    credential = await credentialForPin(input.prisma, input.scope, pin);
  } else if (hasBotPin(bot)) {
    pin = requestedBotPin(bot!);
    credential = await credentialForPin(input.prisma, input.scope, pin);
  } else {
    // Compatibility for bots displaying Space default: capture that one selection once.
    // No settings, deployment, catalog-first, or other-connection fallback is allowed.
    credential = await findSpaceDefault(input.prisma, input.scope);
    const entry = listPiCatalog().find(
      (item) => item.provider === credential?.provider && item.id === credential.defaultModel,
    );
    pin = {
      provider: credential?.provider ?? (input.scripted ? "scripted" : null),
      modelId: credential?.defaultModel ?? (input.scripted ? "scripted" : null),
      effort:
        bot?.thinkingLevel ?? spaceDefaultEffort(entry?.reasoning ?? false, entry?.thinkingLevels),
      credentialId: credential?.id ?? (input.scripted ? "scripted" : null),
      revision: bot?.modelPinRevision ?? 0,
    };
    // A custom space default displays the effort stored with its connection.
    if (credential?.provider === "openai-compatible" && !bot?.thinkingLevel) {
      try {
        loadedModel = await input.loadKey(credential, pin);
        pin.effort = loadedModel.thinkingLevel ?? (loadedModel.reasoning ? "medium" : "off");
      } catch (error) {
        if (error instanceof RuntimePinError) return error.problem;
        throw error;
      }
    }
  }
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
    const problem = validateRuntimePin(resolved, pin);
    return problem ?? { ...resolved, kind: "resolved", pin };
  } catch (error) {
    if (error instanceof RuntimePinError) return error.problem;
    throw error;
  }
}
