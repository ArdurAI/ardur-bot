import { describe, expect, it } from "vitest";
import {
  classifyPeerEffects,
  peerEffectAlwaysHuman,
  peerLimitWindowKey,
  peerPairKey,
} from "./bot-comms-policy.js";

const digest = "a".repeat(64);

describe("peer effect classification", () => {
  it("treats omitted or empty descriptors as read-only preparation", () => {
    expect(classifyPeerEffects([])).toEqual({ kind: "read-only" });
  });

  it("recognizes only a complete exact descriptor", () => {
    expect(
      classifyPeerEffects([
        { kind: "publish", toolName: "publish", resourceRef: "draft", argsDigest: digest },
      ]),
    ).toEqual({
      kind: "exact",
      effect: { kind: "publish", toolName: "publish", resourceRef: "draft", argsDigest: digest },
    });
    expect(classifyPeerEffects([{ kind: "publish", toolName: "publish" }])).toEqual({
      kind: "preparation-only",
    });
    expect(
      classifyPeerEffects([
        { kind: "unknown", toolName: "publish", resourceRef: "draft", argsDigest: digest },
      ]),
    ).toEqual({ kind: "preparation-only" });
    expect(classifyPeerEffects([{ kind: "publish" }, { kind: "delete" }])).toEqual({
      kind: "preparation-only",
    });
  });

  it("keeps host, secret, spend, delete and instruction changes owner-bound", () => {
    for (const kind of [
      "host-command",
      "secret-use",
      "spend",
      "delete",
      "archive",
      "publish",
      "standing-instructions",
      "unknown",
    ] as const)
      expect(peerEffectAlwaysHuman(kind)).toBe(true);
    expect(peerEffectAlwaysHuman("connector-write")).toBe(false);
  });
});

it("uses one unordered pair identity across reversed senders", () => {
  expect(peerPairKey("a", "b")).toBe(peerPairKey("b", "a"));
});

it("only uses notice windows for deduplication", () => {
  expect(peerLimitWindowKey(new Date(59_999), 60_000)).toBe("0");
  expect(peerLimitWindowKey(new Date(60_000), 60_000)).toBe("1");
});
