import { createHash } from "node:crypto";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { findDefaultModelCredential } from "@ardurbot/db";

export const FIRST_BOT_SPAWN_KEY = "onboarding:first";

/** Only persisted, selected account state can advance desktop setup. */
export async function guidedSetupStatus(
  prisma: PrismaClient,
  actor: Actor,
  checkConnection?: (provider: string, modelId: string) => Promise<boolean>,
) {
  const [credential, bot] = await Promise.all([
    findDefaultModelCredential(prisma, actor),
    prisma.bot.findFirst({
      where: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        OR: [{ spawnKey: FIRST_BOT_SPAWN_KEY }, { name: "Chief", spawnKey: null }],
        archivedAt: null,
      },
      select: { id: true },
    }),
  ]);
  const scope = createHash("sha256")
    .update(`${actor.userId.length}:${actor.userId}${actor.spaceId.length}:${actor.spaceId}`)
    .digest("hex");
  let model: "missing" | "saved" | "checked" = credential?.defaultModel ? "saved" : "missing";
  if (model === "saved" && credential?.defaultModel && checkConnection) {
    const checked = await checkConnection(credential.provider, credential.defaultModel).catch(
      () => false,
    );
    if (checked) model = "checked";
  }
  return {
    scope,
    model,
    firstBot: bot !== null,
  };
}
