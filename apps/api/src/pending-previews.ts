import type { Actor } from "@ardurbot/contracts";
import { ORPCError } from "@orpc/server";

type Pending = { expires: number; remove(): void };
const MAX_PENDING_PREVIEWS = 256;
// Shared by MCP and plugin preview stores, across every user and space in this process.
const pending = new Set<Pending>();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleExpiry() {
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  if (!pending.size) return;
  const expires = Math.min(...[...pending].map((entry) => entry.expires));
  expiryTimer = setTimeout(expire, Math.max(0, expires - Date.now()));
  expiryTimer.unref();
}
function expire() {
  const now = Date.now();
  for (const entry of [...pending].sort((a, b) => a.expires - b.expires)) {
    if (entry.expires > now) break;
    entry.remove();
  }
  scheduleExpiry();
}

/** Preview capacity and IDs belong to a user within a space. Expiry also releases payloads. */
export function createOwnerPreviews<T extends { expires: number }>() {
  const owners = new Map<string, Map<string, Pending & { value: T }>>();
  return (owner: Pick<Actor, "spaceId" | "userId">) => {
    expire();
    const key = JSON.stringify([owner.spaceId, owner.userId]);
    return {
      get size() {
        return owners.get(key)?.size ?? 0;
      },
      get(id: string) {
        return owners.get(key)?.get(id)?.value;
      },
      set(id: string, value: T) {
        expire();
        const prior = owners.get(key)?.get(id);
        if (!prior && pending.size >= MAX_PENDING_PREVIEWS)
          throw new ORPCError("TOO_MANY_REQUESTS", {
            message:
              "Too many pending previews. Finish a pending preview or try again after it expires.",
          });
        prior?.remove();
        const previews = owners.get(key) ?? new Map<string, Pending & { value: T }>();
        const entry = {
          value,
          expires: value.expires,
          remove() {
            pending.delete(entry);
            previews.delete(id);
            if (!previews.size) owners.delete(key);
          },
        };
        previews.set(id, entry);
        owners.set(key, previews);
        pending.add(entry);
        scheduleExpiry();
      },
      delete(id: string) {
        const entry = owners.get(key)?.get(id);
        entry?.remove();
        scheduleExpiry();
        return !!entry;
      },
    };
  };
}
