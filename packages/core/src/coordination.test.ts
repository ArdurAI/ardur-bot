import { describe, expect, it } from "vitest";
import {
  COORDINATION_UPDATES_MAX,
  type CoordinationBlock,
  coordinationBlock,
  coordinationCounts,
  coordinationFailureCode,
  coordinationMemberFailureCode,
  fixableFailure,
  outstandingMembers,
  withCoordinationOutcome,
  withCoordinationUpdate,
} from "./coordination.js";

function block(patch: Partial<CoordinationBlock> = {}): CoordinationBlock {
  return {
    kind: "coordination",
    nonce: "group-ask:1:run:call-1",
    round: 1,
    text: "Say hello.",
    updates: [],
    members: [
      { botId: "ada", name: "Ada", outcome: "pending" },
      { botId: "ben", name: "Ben", outcome: "pending" },
    ],
    ...patch,
  };
}

describe("coordinationBlock", () => {
  it("finds the coordination block among a message's blocks", () => {
    const round = block();
    expect(coordinationBlock([{ kind: "text", text: "hi" }, round])).toBe(round);
    expect(coordinationBlock([{ kind: "text", text: "hi" }])).toBeNull();
    expect(coordinationBlock([])).toBeNull();
  });
});

describe("coordinationCounts", () => {
  it("counts asked and answered members", () => {
    const round = block({
      members: [
        { botId: "ada", name: "Ada", outcome: "answered" },
        { botId: "ben", name: "Ben", outcome: "failed", reasonCode: "other" },
        { botId: "cy", name: "Cy", outcome: "pending" },
      ],
    });
    expect(coordinationCounts(round.members)).toEqual({ asked: 3, answered: 1 });
    expect(outstandingMembers(round.members).map((member) => member.botId)).toEqual(["ben", "cy"]);
  });
});

describe("withCoordinationOutcome", () => {
  it("settles a pending member and stamps the update time", () => {
    const next = withCoordinationOutcome(
      block(),
      { botId: "ada", name: "Ada" },
      "answered",
      undefined,
      "2026-09-29T10:00:00.000Z",
    );
    expect(next.members.find((member) => member.botId === "ada")?.outcome).toBe("answered");
    expect(next.members.find((member) => member.botId === "ben")?.outcome).toBe("pending");
    expect(next.updatedAt).toBe("2026-09-29T10:00:00.000Z");
  });

  it("adds a member the round did not list, such as a retry in the same round", () => {
    const next = withCoordinationOutcome(block(), { botId: "cy", name: "Cy" }, "answered");
    expect(next.members).toHaveLength(3);
    expect(next.members.at(-1)).toEqual({ botId: "cy", name: "Cy", outcome: "answered" });
  });

  it("keeps the first terminal outcome for replays, but lets a waiting member settle", () => {
    const failed = withCoordinationOutcome(
      block(),
      { botId: "ada", name: "Ada" },
      "failed",
      "auth",
    );
    expect(withCoordinationOutcome(failed, { botId: "ada", name: "Ada" }, "answered")).toBe(failed);
    const waiting = withCoordinationOutcome(block(), { botId: "ada", name: "Ada" }, "waiting");
    const answered = withCoordinationOutcome(waiting, { botId: "ada", name: "Ada" }, "answered");
    expect(answered.members.find((member) => member.botId === "ada")?.outcome).toBe("answered");
  });

  it("stores the failure as a reason code, not an English sentence", () => {
    const next = withCoordinationOutcome(block(), { botId: "ada", name: "Ada" }, "failed", "auth");
    const ada = next.members.find((member) => member.botId === "ada");
    expect(ada).toEqual({ botId: "ada", name: "Ada", outcome: "failed", reasonCode: "auth" });
    expect(ada && "reason" in ada ? ada.reason : undefined).toBeUndefined();
  });

  it("returns the same block when nothing changes", () => {
    const round = withCoordinationOutcome(block(), { botId: "ada", name: "Ada" }, "failed", "auth");
    expect(withCoordinationOutcome(round, { botId: "ada", name: "Ada" }, "failed", "auth")).toBe(
      round,
    );
  });
});

describe("withCoordinationUpdate", () => {
  it("appends short progress notes and drops empty ones", () => {
    const round = withCoordinationUpdate(block(), "  Asked all three.  ");
    expect(round.updates).toEqual(["Asked all three."]);
    expect(withCoordinationUpdate(round, "   ")).toEqual(round);
  });

  it("caps the notes a chatty coordinator can store", () => {
    let round = block();
    for (let index = 0; index < COORDINATION_UPDATES_MAX + 3; index++)
      round = withCoordinationUpdate(round, `note ${index}`);
    expect(round.updates).toHaveLength(COORDINATION_UPDATES_MAX);
    expect(round.updates.at(-1)).toBe(`note ${COORDINATION_UPDATES_MAX + 2}`);
  });
});

describe("coordinationFailureCode", () => {
  it("classifies each provider failure kind into its reason code", () => {
    expect(
      coordinationFailureCode({
        providerErrorKind: "auth",
        error: "xai API error (403): credits",
      }),
    ).toBe("auth");
    expect(coordinationFailureCode({ providerErrorKind: "rate-limit" })).toBe("rate-limit");
    expect(coordinationFailureCode({ providerErrorKind: "model-unavailable" })).toBe(
      "model-unavailable",
    );
  });

  it("maps an unclassified failure to other and stays silent without one", () => {
    expect(coordinationFailureCode({ error: "boom" })).toBe("other");
    expect(coordinationFailureCode({ providerErrorKind: "unknown-kind", error: "boom" })).toBe(
      "other",
    );
    expect(coordinationFailureCode({})).toBeUndefined();
  });
});

describe("coordinationMemberFailureCode", () => {
  const member = (patch: Record<string, unknown>) => ({
    botId: "ada",
    name: "Ada",
    outcome: "failed" as const,
    ...patch,
  });

  it("prefers the stored reason code", () => {
    expect(
      coordinationMemberFailureCode(member({ reasonCode: "auth", reason: "Ada couldn't answer" })),
    ).toBe("auth");
  });

  it("maps rounds stored with an English reason to their code", () => {
    expect(
      coordinationMemberFailureCode(
        member({ reason: "Ada couldn't answer: its model account needs attention" }),
      ),
    ).toBe("auth");
    expect(
      coordinationMemberFailureCode(
        member({ reason: "Ada couldn't answer: its model account hit a rate limit" }),
      ),
    ).toBe("rate-limit");
    expect(
      coordinationMemberFailureCode(
        member({ reason: "Ada couldn't answer: its model is unavailable" }),
      ),
    ).toBe("model-unavailable");
    expect(coordinationMemberFailureCode(member({ reason: "Ada stopped before answering" }))).toBe(
      "stopped",
    );
    expect(coordinationMemberFailureCode(member({ reason: "Ada couldn't answer" }))).toBe("other");
  });

  it("falls back to the generic code for unknown or missing reasons", () => {
    expect(coordinationMemberFailureCode(member({ reason: "Ada froze mid-reply" }))).toBe("other");
    expect(coordinationMemberFailureCode(member({}))).toBe("other");
  });
});

describe("fixableFailure", () => {
  it("offers a fix only for failed members whose code is owner-actionable", () => {
    for (const reasonCode of ["auth", "rate-limit", "model-unavailable"] as const)
      expect(fixableFailure({ botId: "ada", name: "Ada", outcome: "failed", reasonCode })).toBe(
        true,
      );
    for (const reasonCode of ["stopped", "other"] as const)
      expect(fixableFailure({ botId: "ada", name: "Ada", outcome: "failed", reasonCode })).toBe(
        false,
      );
    expect(fixableFailure({ botId: "ada", name: "Ada", outcome: "answered" })).toBe(false);
  });

  it("reads old English reasons so their fix link still follows the code", () => {
    expect(
      fixableFailure({
        botId: "ada",
        name: "Ada",
        outcome: "failed",
        reason: "Ada couldn't answer: its model account needs attention",
      }),
    ).toBe(true);
    expect(
      fixableFailure({
        botId: "ada",
        name: "Ada",
        outcome: "failed",
        reason: "Ada couldn't answer",
      }),
    ).toBe(false);
    expect(fixableFailure({ botId: "ada", name: "Ada", outcome: "failed" })).toBe(false);
  });
});
