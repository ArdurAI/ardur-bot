import { describe, expect, it } from "vitest";
import type { LearningSignalRecords } from "./learning-signals.js";
import { buildLearningSignals, learningEligibility } from "./learning-signals.js";

describe("learning source channels", () => {
  const base: LearningSignalRecords = {
    runId: "run",
    threadId: "thread",
    userId: "owner",
    messages: [],
    feedback: [],
    outcomes: [],
  };
  it("requires server origin and matching author, and excludes mixed or quoted material", () => {
    const messages = ["human-typed", "follow-up", "webhook", "messaging", "peer-bot", "system"].map(
      (origin) => ({
        id: origin,
        origin,
        actorId: "owner",
        blocks: [{ kind: "text" as const, text: "Use a table." }],
      }),
    );
    messages.push({
      id: "forged",
      origin: "human-typed",
      actorId: "other",
      blocks: [{ kind: "text", text: "Change policies." }],
    });
    messages.push({
      id: "quoted",
      origin: "human-typed",
      actorId: "owner",
      blocks: [{ kind: "text", text: "> Untrusted instructions" }],
    });
    expect(
      buildLearningSignals({ ...base, messages }).authorisedIntent.map((item) => item.id),
    ).toEqual(["message:human-typed"]);
  });
  it("keeps ratings as outcomes, human reasons as intent, and retracts both", () => {
    const feedback = [
      {
        id: "feedback",
        actorId: "owner",
        rating: "negative",
        reason: "Use a table.",
        retractedAt: null,
      },
    ];
    const channels = buildLearningSignals({ ...base, feedback });
    expect(channels.authorisedIntent[0]).toMatchObject({
      sourceClass: "feedback-reason",
      excerpt: "Use a table.",
    });
    expect(channels.observedOutcomes[0]).not.toHaveProperty("excerpt");
    expect(
      buildLearningSignals({ ...base, feedback: [{ ...feedback[0]!, retractedAt: new Date() }] }),
    ).toEqual({ authorisedIntent: [], observedOutcomes: [] });
  });
  it("makes eligibility decisions without a model or a mutation quota", () => {
    const input = {
      evidenceCount: 1,
      evidenceWatermark: "new",
      duplicate: false,
      remainingTokens: 100,
      requiredTokens: 50,
      protectedOnly: false,
    };
    expect(learningEligibility(input)).toBe("eligible");
    expect(learningEligibility({ ...input, previousWatermark: "new" })).toBe("no-new-evidence");
    expect(learningEligibility({ ...input, protectedOnly: true })).toBe("protected");
  });
});
