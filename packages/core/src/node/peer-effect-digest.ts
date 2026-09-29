import { createHash } from "node:crypto";
import type { PeerEffectDescriptor } from "@ardurbot/contracts";
import { stableJsonValue } from "../approval-effect-key.js";
import type { PeerEffectMismatchReason } from "../bot-comms-policy.js";
import { classifyPeerEffects } from "../bot-comms-policy.js";

export type { PeerEffectMismatchReason };

/** Structural identity: key order cannot change what the peer will run. */
export function peerEffectArgsDigest(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableJsonValue(args)).digest("hex");
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
