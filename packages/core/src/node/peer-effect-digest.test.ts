import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approvalEffectKey, stableJsonValue } from "../approval-effect-key.js";
import { peerEffectArgsDigest } from "./peer-effect-digest.js";

// Pinned with the pre-move implementation (sha256 over stableJsonValue) so
// holds created before the Node-only split still match, byte for byte.
const PINNED_ARGS = { title: "Draft", version: 3 };
const PINNED_DIGEST = "020a8abc2335a02b1076fdf17b7da7f9962f34fd7fc8daeea682b9a93e704ef2";

describe("peer effect argument digest", () => {
  it("pins the digest of one fixed argument object to its exact hex value", () => {
    expect(peerEffectArgsDigest(PINNED_ARGS)).toBe(PINNED_DIGEST);
  });

  it("reuses the approval effect key canonical serialization and hash", () => {
    expect(peerEffectArgsDigest(PINNED_ARGS)).toBe(
      createHash("sha256").update(stableJsonValue(PINNED_ARGS)).digest("hex"),
    );
    expect(approvalEffectKey("run", "tool", PINNED_ARGS).endsWith(PINNED_DIGEST)).toBe(true);
  });

  it("digests arguments independent of key order", () => {
    expect(peerEffectArgsDigest({ a: 1, b: { c: [2, 3], d: null } })).toBe(
      peerEffectArgsDigest({ b: { d: null, c: [2, 3] }, a: 1 }),
    );
    expect(peerEffectArgsDigest({ a: 1 })).not.toBe(peerEffectArgsDigest({ a: "1" }));
  });
});
