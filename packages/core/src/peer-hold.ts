import type { PeerEffectDescriptor } from "@ardurbot/contracts";
import { PeerEffectDescriptorSchema } from "@ardurbot/contracts";

/** The request envelope persisted on a peer_hold external effect. */
export const PEER_HOLD_KIND = "peer_hold";

export type PeerHoldRequest = {
  deliveryId: string;
  authorityFingerprint: string;
  requestedEffects: unknown;
  preparationOnly: boolean;
  boundEffect?: unknown;
};

export function parsePeerHoldRequest(request: unknown): PeerHoldRequest | undefined {
  if (!request || typeof request !== "object" || Array.isArray(request)) return undefined;
  const record = request as Record<string, unknown>;
  if (
    typeof record.deliveryId !== "string" ||
    typeof record.authorityFingerprint !== "string" ||
    !Array.isArray(record.requestedEffects)
  )
    return undefined;
  return {
    deliveryId: record.deliveryId,
    authorityFingerprint: record.authorityFingerprint,
    requestedEffects: record.requestedEffects,
    preparationOnly: record.preparationOnly !== false,
    boundEffect: record.boundEffect,
  };
}

/** The one exact bound effect, revalidated against the stored descriptor list. */
export function peerHoldBoundEffect(
  request: unknown,
): { kind: "bound"; effect: PeerEffectDescriptor } | { kind: "preparation" } | { kind: "invalid" } {
  const hold = parsePeerHoldRequest(request);
  if (!hold) return { kind: "invalid" };
  if (hold.preparationOnly) return { kind: "preparation" };
  const bound = PeerEffectDescriptorSchema.safeParse(hold.boundEffect);
  if (!bound.success) return { kind: "invalid" };
  // The stored descriptor list must still carry the exact same binding.
  if (
    !(hold.requestedEffects as unknown[]).some(
      (effect) =>
        effect &&
        typeof effect === "object" &&
        (effect as PeerEffectDescriptor).toolName === bound.data.toolName &&
        (effect as PeerEffectDescriptor).resourceRef === bound.data.resourceRef &&
        (effect as PeerEffectDescriptor).argsDigest === bound.data.argsDigest,
    )
  )
    return { kind: "invalid" };
  return { kind: "bound", effect: bound.data };
}
