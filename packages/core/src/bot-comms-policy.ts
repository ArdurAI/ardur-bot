import { createHash } from "node:crypto";
import type { PeerEffectDescriptor } from "@ardurbot/contracts";
import { stableJsonValue } from "./approval-effect-key.js";

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

/**
 * Only an exact descriptor whose owner-readable arguments match its digest can
 * bind one executable effect. Anything else stays preparation-only.
 */
export function classifyPeerEffectBinding(
  effects: readonly PeerEffectDescriptor[],
):
  | { kind: "read-only" }
  | { kind: "effect-bound"; effect: PeerEffectDescriptor }
  | { kind: "preparation-only" } {
  const classified = classifyPeerEffects(effects);
  if (classified.kind !== "exact") return classified;
  if (!classified.effect.args) return { kind: "preparation-only" };
  if (peerEffectArgsDigest(classified.effect.args) !== classified.effect.argsDigest)
    return { kind: "preparation-only" };
  return { kind: "effect-bound", effect: classified.effect };
}

/** Structural identity: key order cannot change what the peer will run. */
export function peerEffectArgsDigest(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableJsonValue(args)).digest("hex");
}

export type PeerEffectMismatchReason = "unbound" | "tool" | "resource" | "arguments";

/** Exact match of the approved effect: tool, target resource and argument digest. */
export function peerEffectMatches(
  approved: PeerEffectDescriptor | undefined,
  live: { toolName: string; resourceRef: string; args: Record<string, unknown> },
): { ok: true } | { ok: false; reason: PeerEffectMismatchReason } {
  if (!approved?.toolName || !approved.resourceRef || !approved.argsDigest || !approved.args)
    return { ok: false, reason: "unbound" };
  if (approved.toolName !== live.toolName) return { ok: false, reason: "tool" };
  if (approved.resourceRef !== live.resourceRef) return { ok: false, reason: "resource" };
  if (peerEffectArgsDigest(live.args) !== approved.argsDigest)
    return { ok: false, reason: "arguments" };
  return { ok: true };
}

export function peerEffectAlwaysHuman(kind: PeerEffectDescriptor["kind"]): boolean {
  return !["connector-write", "mcp-write"].includes(kind);
}

export function peerLimitWindowKey(now: Date, durationMs: number): string {
  // This key only deduplicates the owner notice. Admission uses rolling timestamps.
  return String(Math.floor(now.getTime() / durationMs));
}
