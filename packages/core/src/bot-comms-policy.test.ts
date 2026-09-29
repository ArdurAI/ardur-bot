import { describe, expect, it } from "vitest";
import {
  classifyPeerEffectBinding,
  classifyPeerEffects,
  peerEffectAlwaysHuman,
  peerEffectArgsDigest,
  peerEffectMatches,
  peerEffectResourceRef,
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

describe("peer effect binding", () => {
  const args = { title: "Draft", version: 3 };

  it("binds only an exact descriptor whose arguments match its digest", () => {
    const bound = {
      kind: "connector-write" as const,
      toolName: "destination.write",
      resourceRef: "destination:drafts",
      argsDigest: peerEffectArgsDigest(args),
      args,
    };
    expect(classifyPeerEffectBinding([bound])).toEqual({ kind: "effect-bound", effect: bound });
  });

  it("stays preparation-only when arguments are missing or the digest differs", () => {
    const base = {
      kind: "connector-write" as const,
      toolName: "destination.write",
      resourceRef: "destination:drafts",
      argsDigest: peerEffectArgsDigest(args),
    };
    expect(classifyPeerEffectBinding([base])).toEqual({ kind: "preparation-only" });
    expect(classifyPeerEffectBinding([{ ...base, argsDigest: "b".repeat(64), args }])).toEqual({
      kind: "preparation-only",
    });
    expect(classifyPeerEffectBinding([{ ...base, args: { ...args, extra: true } }])).toEqual({
      kind: "preparation-only",
    });
  });

  it("digests arguments independent of key order", () => {
    expect(peerEffectArgsDigest({ a: 1, b: { c: [2, 3], d: null } })).toBe(
      peerEffectArgsDigest({ b: { d: null, c: [2, 3] }, a: 1 }),
    );
    expect(peerEffectArgsDigest({ a: 1 })).not.toBe(peerEffectArgsDigest({ a: "1" }));
  });

  it("maps connector routes to descriptor resource identity", () => {
    expect(
      peerEffectResourceRef({ connectorId: "pipedream", resourceId: "slack", toolName: "post" }),
    ).toBe("pipedream:slack");
    expect(
      peerEffectResourceRef({ connectorId: "mcp", resourceId: "srv", toolName: "write" }),
    ).toBe("mcp:srv:write");
    expect(peerEffectResourceRef({ connectorId: "pipedream", toolName: "post" })).toBe(
      "pipedream:",
    );
  });
});

describe("peer effect matching", () => {
  const args = { title: "Draft", version: 3 };
  const approved = {
    kind: "connector-write" as const,
    toolName: "destination.write",
    resourceRef: "destination:drafts",
    argsDigest: peerEffectArgsDigest(args),
    args,
  };
  const live = {
    toolName: "destination.write",
    resourceRef: "destination:drafts",
    args,
  };

  it("accepts the exact approved tool, target and arguments", () => {
    expect(peerEffectMatches(approved, live)).toEqual({ ok: true });
    expect(peerEffectMatches(approved, { ...live, args: { version: 3, title: "Draft" } })).toEqual({
      ok: true,
    });
  });

  it("refuses an unbound approval", () => {
    expect(peerEffectMatches(undefined, live)).toEqual({ ok: false, reason: "unbound" });
    expect(peerEffectMatches({ kind: "connector-write" }, live)).toEqual({
      ok: false,
      reason: "unbound",
    });
    expect(peerEffectMatches({ ...approved, args: undefined }, live)).toEqual({
      ok: false,
      reason: "unbound",
    });
  });

  it("refuses a different tool", () => {
    expect(peerEffectMatches(approved, { ...live, toolName: "destination.delete" })).toEqual({
      ok: false,
      reason: "tool",
    });
  });

  it("refuses a different target", () => {
    expect(peerEffectMatches(approved, { ...live, resourceRef: "destination:other" })).toEqual({
      ok: false,
      reason: "resource",
    });
  });

  it("refuses changed arguments", () => {
    for (const changed of [{ ...args, version: 4 }, { ...args, extra: true }, { title: "Draft" }])
      expect(peerEffectMatches(approved, { ...live, args: changed })).toEqual({
        ok: false,
        reason: "arguments",
      });
  });
});

it("only uses notice windows for deduplication", () => {
  expect(peerLimitWindowKey(new Date(59_999), 60_000)).toBe("0");
  expect(peerLimitWindowKey(new Date(60_000), 60_000)).toBe("1");
});
