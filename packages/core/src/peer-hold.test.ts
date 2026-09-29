import { describe, expect, it } from "vitest";
import { peerEffectArgsDigest } from "./bot-comms-policy.js";
import { parsePeerHoldRequest, peerHoldBoundEffect } from "./peer-hold.js";

const args = { title: "Draft", version: 3 };
const descriptor = {
  kind: "connector-write" as const,
  toolName: "destination.write",
  resourceRef: "destination:drafts",
  argsDigest: peerEffectArgsDigest(args),
  args,
};

function holdRequest(overrides: Record<string, unknown> = {}) {
  return {
    deliveryId: "delivery-1",
    authorityFingerprint: "fingerprint",
    requestedEffects: [descriptor],
    preparationOnly: false,
    boundEffect: descriptor,
    ...overrides,
  };
}

describe("parsePeerHoldRequest", () => {
  it("parses the stored envelope and defaults to preparation", () => {
    expect(parsePeerHoldRequest(holdRequest())).toMatchObject({
      deliveryId: "delivery-1",
      preparationOnly: false,
    });
    const preparation = parsePeerHoldRequest(
      holdRequest({ preparationOnly: undefined, boundEffect: undefined }),
    );
    expect(preparation?.preparationOnly).toBe(true);
  });

  it("refuses malformed envelopes", () => {
    for (const request of [
      null,
      "peer_hold",
      [],
      {},
      { deliveryId: "delivery-1" },
      { deliveryId: "delivery-1", authorityFingerprint: "fingerprint", requestedEffects: {} },
    ])
      expect(parsePeerHoldRequest(request)).toBeUndefined();
  });
});

describe("peerHoldBoundEffect", () => {
  it("returns the exact bound effect for a valid effect-bound hold", () => {
    expect(peerHoldBoundEffect(holdRequest())).toEqual({ kind: "bound", effect: descriptor });
  });

  it("treats a preparation hold as read-only", () => {
    expect(
      peerHoldBoundEffect(holdRequest({ preparationOnly: true, boundEffect: undefined })),
    ).toEqual({ kind: "preparation" });
  });

  it("fails closed when the envelope or its descriptor list drifts", () => {
    expect(peerHoldBoundEffect({})).toEqual({ kind: "invalid" });
    expect(peerHoldBoundEffect(holdRequest({ boundEffect: { kind: "delete" } }))).toEqual({
      kind: "invalid",
    });
    expect(peerHoldBoundEffect(holdRequest({ boundEffect: undefined }))).toEqual({
      kind: "invalid",
    });
    expect(
      peerHoldBoundEffect(
        holdRequest({
          boundEffect: { ...descriptor, argsDigest: "c".repeat(64) },
        }),
      ),
    ).toEqual({ kind: "invalid" });
    expect(peerHoldBoundEffect(holdRequest({ requestedEffects: [] }))).toEqual({
      kind: "invalid",
    });
  });
});
