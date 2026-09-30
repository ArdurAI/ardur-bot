import { peerEffectArgsDigest } from "@ardurbot/core/node/peer-effect-digest";
import { describe, expect, it } from "vitest";
import { claimPeerBoundEffect, loadPeerBoundEffect } from "./peer-bound-effect.js";

const args = { title: "Draft", version: 3 };
const descriptor = {
  kind: "connector-write" as const,
  toolName: "destination.write",
  resourceRef: "destination:drafts",
  argsDigest: peerEffectArgsDigest(args),
  args,
};
const boundRequest = {
  deliveryId: "delivery-1",
  authorityFingerprint: "fingerprint",
  requestedEffects: [descriptor],
  preparationOnly: false,
  boundEffect: descriptor,
};
const live = { toolName: "destination.write", resourceRef: "destination:drafts", args };

function effectStore(initial: { id: string; status: string; request: unknown; result?: unknown }) {
  const state = { ...initial };
  const store = {
    externalEffect: {
      findFirst: async ({
        where,
      }: {
        where: { runId: string; kind: string; status?: string };
        orderBy: { createdAt: "desc" };
        select: { id: true; request: true; status: true };
      }) => {
        if (where.kind !== "peer_hold") return null;
        if (where.status && state.status !== where.status) return null;
        return { id: state.id, request: state.request, status: state.status };
      },
      findUnique: async () => ({ status: state.status, result: state.result }),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: { status: string; result?: unknown };
      }) => {
        if (where.id !== state.id || state.status !== where.status) return { count: 0 };
        state.status = data.status;
        state.result = data.result;
        return { count: 1 };
      },
    },
  };
  return { state, store };
}

describe("loadPeerBoundEffect", () => {
  it("returns the bound effect only for a valid effect-bound hold", async () => {
    const { store } = effectStore({ id: "effect-1", status: "approved", request: boundRequest });
    await expect(loadPeerBoundEffect(store, "run-1")).resolves.toEqual({
      effectId: "effect-1",
      effect: descriptor,
    });
  });

  it("degrades preparation and malformed holds to read-only", async () => {
    const preparation = effectStore({
      id: "effect-1",
      status: "approved",
      request: { ...boundRequest, preparationOnly: true, boundEffect: undefined },
    });
    await expect(loadPeerBoundEffect(preparation.store, "run-1")).resolves.toBeNull();
    const malformed = effectStore({ id: "effect-1", status: "approved", request: {} });
    await expect(loadPeerBoundEffect(malformed.store, "run-1")).resolves.toBeNull();
  });

  it("hides the tool again once the approval is no longer approved", async () => {
    const { store, state } = effectStore({
      id: "effect-1",
      status: "approved",
      request: boundRequest,
    });
    await expect(
      loadPeerBoundEffect(store, "run-1", { approvedOnly: true }),
    ).resolves.not.toBeNull();
    state.status = "failed";
    await expect(loadPeerBoundEffect(store, "run-1", { approvedOnly: true })).resolves.toBeNull();
  });
});

describe("claimPeerBoundEffect", () => {
  it("claims the approved effect exactly once and refuses the replay", async () => {
    const { store, state } = effectStore({
      id: "effect-1",
      status: "approved",
      request: boundRequest,
    });
    const bound = { effectId: "effect-1", effect: descriptor };
    await expect(claimPeerBoundEffect(store, bound, live)).resolves.toEqual({ ok: true });
    expect(state.status).toBe("executing");
    state.status = "completed";
    await expect(claimPeerBoundEffect(store, bound, live)).resolves.toEqual({
      ok: false,
      kind: "replay",
    });
  });

  it("refuses a different tool, target or arguments before claiming", async () => {
    const { store, state } = effectStore({
      id: "effect-1",
      status: "approved",
      request: boundRequest,
    });
    const bound = { effectId: "effect-1", effect: descriptor };
    await expect(
      claimPeerBoundEffect(store, bound, { ...live, toolName: "destination.delete" }),
    ).resolves.toEqual({ ok: false, kind: "mismatch", reason: "tool" });
    await expect(
      claimPeerBoundEffect(store, bound, { ...live, resourceRef: "destination:other" }),
    ).resolves.toEqual({ ok: false, kind: "mismatch", reason: "resource" });
    await expect(
      claimPeerBoundEffect(store, bound, { ...live, args: { ...args, version: 4 } }),
    ).resolves.toEqual({ ok: false, kind: "mismatch", reason: "arguments" });
    // A refused call never consumed the approval.
    expect(state.status).toBe("approved");
    await expect(claimPeerBoundEffect(store, bound, live)).resolves.toEqual({ ok: true });
  });

  it("settles an interrupted execution as uncertain instead of running twice", async () => {
    const { store, state } = effectStore({
      id: "effect-1",
      status: "executing",
      request: boundRequest,
    });
    const bound = { effectId: "effect-1", effect: descriptor };
    const claim = await claimPeerBoundEffect(store, bound, live);
    expect(claim).toMatchObject({ ok: false, kind: "uncertain" });
    expect(state.status).toBe("uncertain");
    expect(state.result).toMatchObject({ uncertain: true });
  });

  it("refuses a denied or failed approval", async () => {
    for (const status of ["denied", "failed"]) {
      const { store } = effectStore({ id: "effect-1", status, request: boundRequest });
      const bound = { effectId: "effect-1", effect: descriptor };
      await expect(claimPeerBoundEffect(store, bound, live)).resolves.toEqual({
        ok: false,
        kind: "replay",
      });
    }
  });
});
