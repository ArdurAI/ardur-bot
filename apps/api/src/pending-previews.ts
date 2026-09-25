import type { Actor } from "@ardurbot/contracts";

/** Preview capacity and IDs belong to a user within a space. Expiry also releases payloads. */
export function createOwnerPreviews<T extends { expires: number }>() {
  const owners = new Map<string, Map<string, T>>();
  return (owner: Pick<Actor, "spaceId" | "userId">) => {
    const now = Date.now();
    for (const [key, previews] of owners) {
      for (const [id, preview] of previews) if (preview.expires <= now) previews.delete(id);
      if (!previews.size) owners.delete(key);
    }
    const key = JSON.stringify([owner.spaceId, owner.userId]);
    let previews = owners.get(key);
    if (!previews) {
      previews = new Map<string, T>();
      owners.set(key, previews);
    }
    return previews;
  };
}
