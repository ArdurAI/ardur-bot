import type { PeerEffectDescriptor } from "@ardurbot/contracts";

export const PEER_PAIR_PER_MINUTE = 4;
export const PEER_GOAL_SENDS_PER_HOUR = 60;
export const PEER_SPACE_SENDS_PER_HOUR = 120;
export const PEER_GOAL_WAKES_PER_HOUR = 12;
export const PEER_SPACE_WAKES_PER_HOUR = 24;

export function peerPairKey(left: string, right: string): string {
  return [left, right].sort().join(":");
}

/** A description is a request for review, never executable authority. */
export function classifyPeerEffects(
  effects: readonly PeerEffectDescriptor[],
):
  | { kind: "read-only" }
  | { kind: "exact"; effect: PeerEffectDescriptor }
  | { kind: "preparation-only" } {
  if (effects.length === 0) return { kind: "read-only" };
  if (effects.length !== 1) return { kind: "preparation-only" };
  const [effect] = effects;
  if (!effect || effect.kind === "unknown") return { kind: "preparation-only" };
  if (!effect.toolName || !effect.resourceRef || !effect.argsDigest)
    return { kind: "preparation-only" };
  return { kind: "exact", effect };
}

export function peerEffectAlwaysHuman(kind: PeerEffectDescriptor["kind"]): boolean {
  return !["connector-write", "mcp-write"].includes(kind);
}

export function peerLimitWindowKey(now: Date, durationMs: number): string {
  // This key only deduplicates the owner notice. Admission uses rolling timestamps.
  return String(Math.floor(now.getTime() / durationMs));
}
