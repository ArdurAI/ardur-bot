import type { canBotRun } from "@ardurbot/adapters";
import type { Actor, UpdateBotInput } from "@ardurbot/contracts";
import type { Prisma } from "@ardurbot/db";
import { normalizeModelPinUpdate } from "./model-pin-validation.js";
import type { RouterDeps } from "./router.js";

/** Persist the normalized choice in the bot's global columns. */
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
  policies?: Pick<Parameters<typeof canBotRun>[0], "botPolicy" | "spacePolicy">,
): Promise<Prisma.BotUpdateInput> {
  return normalizeModelPinUpdate(deps, actor, existing, input, policies);
}
