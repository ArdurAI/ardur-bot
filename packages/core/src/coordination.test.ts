import { describe, expect, it } from "vitest";
import {
  COORDINATION_UPDATES_MAX,
  type CoordinationBlock,
  coordinationBlock,
  coordinationCounts,
  coordinationFailureReason,
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
        { botId: "ben", name: "Ben", outcome: "failed", reason: "Ben couldn't answer" },
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
      "Ada couldn't answer",
    );
    expect(withCoordinationOutcome(failed, { botId: "ada", name: "Ada" }, "answered")).toBe(failed);
    const waiting = withCoordinationOutcome(block(), { botId: "ada", name: "Ada" }, "waiting");
    const answered = withCoordinationOutcome(waiting, { botId: "ada", name: "Ada" }, "answered");
    expect(answered.members.find((member) => member.botId === "ada")?.outcome).toBe("answered");
  });

  it("returns the same block when nothing changes", () => {
    const round = withCoordinationOutcome(
      block(),
      { botId: "ada", name: "Ada" },
      "failed",
      "Ada couldn't answer",
    );
    expect(
      withCoordinationOutcome(
        round,
        { botId: "ada", name: "Ada" },
        "failed",
        "Ada couldn't answer",
      ),
    ).toBe(round);
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

describe("coordinationFailureReason", () => {
  it("classifies provider failures into plain sentences", () => {
    expect(
      coordinationFailureReason({
        botName: "Radiant",
        providerErrorKind: "auth",
        error: "xai API error (403): credits",
      }),
    ).toBe("Radiant couldn't answer: its model account needs attention");
    expect(coordinationFailureReason({ botName: "Radiant", providerErrorKind: "rate-limit" })).toBe(
      "Radiant couldn't answer: its model account hit a rate limit",
    );
    expect(
      coordinationFailureReason({ botName: "Radiant", providerErrorKind: "model-unavailable" }),
    ).toBe("Radiant couldn't answer: its model is unavailable");
  });

  it("never leaks raw provider text", () => {
    const reason = coordinationFailureReason({
      botName: "Radiant",
      providerErrorKind: "auth",
      error: "xai API error (403): You have run out of credits",
    });
    expect(reason).not.toContain("403");
    expect(reason).not.toContain("xai");
    expect(coordinationFailureReason({ botName: "Radiant", error: "boom" })).toBe(
      "Radiant couldn't answer",
    );
    expect(coordinationFailureReason({ botName: "Radiant" })).toBeUndefined();
  });
});

describe("fixableFailure", () => {
  it("offers a fix only for failed members with an owner-actionable cause", () => {
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
    expect(fixableFailure({ botId: "ada", name: "Ada", outcome: "answered" })).toBe(false);
  });
});
