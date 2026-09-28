import { useCallback } from "react";
import { rpc, selectedSpaceId } from "./rpc";

const FIRST_BOT_NAME = "Chief";
const FIRST_BOT_SPAWN_KEY = "onboarding:first";
const pendingBySpace = new Map<string, Promise<{ id: string }>>();

async function createOrReuseFirstBot(): Promise<{ id: string }> {
  const existing = await rpc.bots.list();
  const saved = existing.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
  if (saved) return { id: saved.id };
  const legacy = existing.find((bot) => bot.name === FIRST_BOT_NAME);
  if (legacy) return { id: legacy.id };
  try {
    const created = await rpc.bots.create({
      name: FIRST_BOT_NAME,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      spawnKey: FIRST_BOT_SPAWN_KEY,
    });
    return { id: created.id };
  } catch (error) {
    // The server's unique (spaceId, spawnKey) constraint settles concurrent tabs.
    const afterConflict = await rpc.bots.list();
    const winner = afterConflict.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
    if (winner) return { id: winner.id };
    throw error;
  }
}

export async function ensureFirstBot(): Promise<{ id: string }> {
  const scope = selectedSpaceId() ?? "default";
  const pending = pendingBySpace.get(scope);
  if (pending) return pending;
  const run = async () => {
    const locks = globalThis.navigator?.locks;
    return locks?.request
      ? locks.request(`ardurbot:onboarding-first-bot:${scope}`, createOrReuseFirstBot)
      : createOrReuseFirstBot();
  };
  const created = run().finally(() => pendingBySpace.delete(scope));
  pendingBySpace.set(scope, created);
  return created;
}

export function useFirstBotSetup() {
  return useCallback(() => ensureFirstBot(), []);
}
