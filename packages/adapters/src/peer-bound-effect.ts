import type { PeerEffectDescriptor } from "@ardurbot/contracts";
import type { PeerEffectMismatchReason } from "@ardurbot/core";
import { peerEffectMatches, peerHoldBoundEffect } from "@ardurbot/core";
import type { ExternalEffectStore } from "./approval-effect.js";
import { claimApprovedEffect, settleUncertainEffect } from "./approval-effect.js";

/** The one exact effect an approved peer hold binds to a recipient run. */
export type PeerBoundEffect = { effectId: string; effect: PeerEffectDescriptor };

export type PeerBoundEffectStore = ExternalEffectStore & {
  externalEffect: {
    findFirst: (args: {
      where: { runId: string; kind: string; status?: string };
      orderBy: { createdAt: "desc" };
      select: { id: true; request: true; status: true };
    }) => Promise<{ id: string; request: unknown; status: string } | null>;
    findUnique: (args: {
      where: { id: string };
    }) => Promise<{ status: string; result?: unknown } | null>;
    updateMany: ExternalEffectStore["externalEffect"]["updateMany"];
  };
};

/**
 * Read the bound descriptor from the run's peer hold. Anything that is not a
 * valid effect-bound hold degrades to read-only, so a corrupt or preparation
 * hold never widens what the peer may do. Exposure passes approvedOnly so a
 * consumed or refused approval hides the tool again.
 */
export async function loadPeerBoundEffect(
  store: PeerBoundEffectStore,
  runId: string,
  options: { approvedOnly?: boolean } = {},
): Promise<PeerBoundEffect | null> {
  const hold = await store.externalEffect.findFirst({
    where: {
      runId,
      kind: "peer_hold",
      ...(options.approvedOnly ? { status: "approved" } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, request: true, status: true },
  });
  if (!hold) return null;
  const bound = peerHoldBoundEffect(hold.request);
  return bound.kind === "bound" ? { effectId: hold.id, effect: bound.effect } : null;
}

export type PeerBoundClaim =
  | { ok: true }
  | { ok: false; kind: "mismatch"; reason: PeerEffectMismatchReason }
  | { ok: false; kind: "replay" }
  | { ok: false; kind: "uncertain"; result: unknown };

/**
 * The dispatch gate for a held exact write: the call must match the approved
 * tool, target and argument digest, then one atomic approved-to-executing
 * claim decides who may run it. A second claim is a recorded replay refusal;
 * an interrupted execution settles as uncertain instead of running twice.
 */
export async function claimPeerBoundEffect(
  store: PeerBoundEffectStore,
  bound: PeerBoundEffect,
  live: { toolName: string; resourceRef: string; args: Record<string, unknown> },
): Promise<PeerBoundClaim> {
  const match = peerEffectMatches(bound.effect, live);
  if (!match.ok) return { ok: false, kind: "mismatch", reason: match.reason };
  if (await claimApprovedEffect(store, bound.effectId)) return { ok: true };
  const current = await store.externalEffect.findUnique({ where: { id: bound.effectId } });
  if (current?.status === "executing") {
    return {
      ok: false,
      kind: "uncertain",
      result: await settleUncertainEffect(store, bound.effectId, live.toolName),
    };
  }
  return { ok: false, kind: "replay" };
}
