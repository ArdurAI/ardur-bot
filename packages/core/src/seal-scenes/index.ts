import { landscapesWonders } from "./packs/landscapes-wonders.js";
import { simpleRing } from "./packs/simple-ring.js";
import type { SealScenePack } from "./types.js";

export * from "./phase.js";
export * from "./render.js";
export * from "./types.js";

/** Every registered pack, by id. Register a new pack here. */
export const SEAL_SCENE_PACKS: Readonly<Record<string, SealScenePack>> = {
  [landscapesWonders.id]: landscapesWonders,
  [simpleRing.id]: simpleRing,
};

/** The pack every seal uses unless the reader chose another. */
export const DEFAULT_SEAL_SCENE_PACK = landscapesWonders.id;

/** The pack with this id, or the default for an unknown or missing id. */
export function sealScenePack(id?: string | null): SealScenePack {
  return (id ? SEAL_SCENE_PACKS[id] : undefined) ?? SEAL_SCENE_PACKS[DEFAULT_SEAL_SCENE_PACK]!;
}
