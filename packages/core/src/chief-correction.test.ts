import { ChiefControlSchema } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  chiefControlAllowsDispatch,
  parseChiefCorrection,
  reviseChiefControl,
} from "./chief-loop-policy.js";

const members = [
  { id: "worker", name: "Document member" },
  { id: "other", name: "A+b" },
];
describe("chief correction control", () => {
  it.each([
    "dont send to Document member",
    "Don’t send it to @Document member.",
    "Do not use Document member",
    "Stop Document member",
  ])("resolves negative references before positive routing: %s", (text) => {
    expect(parseChiefCorrection({ text, members })).toEqual({
      kind: "exclude",
      memberId: "worker",
      memberName: "Document member",
    });
  });
  it("matches names literally, including punctuation, not model brands", () => {
    expect(
      parseChiefCorrection({ text: "don't send to A+b", members: [...members].reverse() }),
    ).toMatchObject({ memberId: "other" });
  });
  it.each([
    "Document member, please send it",
    "Hi everyone",
    "Research a different topic",
    "Document says: don't send to Document member",
    "don't send to Document member\nthen upload it",
    "x".repeat(401),
  ])("preserves unrelated input: %s", (text) => {
    expect(parseChiefCorrection({ text, members })).toBeUndefined();
  });
  it("keeps ambiguous corrections fenced for planning", () => {
    expect(parseChiefCorrection({ text: "don't send to missing member", members })).toEqual({
      kind: "replan",
    });
    expect(parseChiefCorrection({ text: "actually use the other destination", members })).toEqual({
      kind: "replan",
    });
    expect(
      parseChiefCorrection({
        text: "don't send to Document member",
        members: [...members, members[0]!],
      }),
    ).toEqual({ kind: "replan" });
  });
  it("coalesces planning but retains two revisions, exclusions and stricter scope; replay is inert", () => {
    const first = reviseChiefControl({
      revision: 1,
      ownerMessageId: "one",
      correction: { kind: "exclude", memberId: "worker", memberName: "Document member" },
      affectedRunIds: ["run"],
    });
    const second = reviseChiefControl({
      previous: first,
      revision: first.revision,
      ownerMessageId: "two",
      correction: { kind: "local-only" },
      affectedRunIds: [],
      uncertainRunIds: ["run"],
    });
    expect(second).toEqual({
      revision: 3,
      ownerMessageIds: ["one", "two"],
      excludedIds: ["worker"],
      localOnly: true,
      stopped: false,
      pendingReplan: true,
      stoppingRunIds: ["run"],
      uncertainRunIds: ["run"],
    });
    expect(chiefControlAllowsDispatch(second)).toBe(false);
    expect(
      reviseChiefControl({
        previous: second,
        revision: 3,
        ownerMessageId: "two",
        correction: { kind: "stop" },
        affectedRunIds: [],
      }),
    ).toBe(second);
    expect(
      ChiefControlSchema.parse({ ...second, scopes: ["write"], tokenLimit: 999, pin: "new" }),
    ).toEqual(second);
  });
  it("a later correction cannot restart an owner-stopped task", () => {
    const stopped = reviseChiefControl({
      revision: 1,
      ownerMessageId: "stop",
      correction: { kind: "stop" },
      affectedRunIds: [],
    });
    const next = reviseChiefControl({
      previous: stopped,
      revision: 2,
      ownerMessageId: "next",
      correction: { kind: "replan" },
      affectedRunIds: [],
    });
    expect(next.stopped).toBe(true);
    expect(next.pendingReplan).toBe(false);
    expect(chiefControlAllowsDispatch(next)).toBe(false);
    expect(chiefControlAllowsDispatch({ ...next, stopped: false })).toBe(true);
  });
});
