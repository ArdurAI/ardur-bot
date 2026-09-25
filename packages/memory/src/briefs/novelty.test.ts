import { expect, it } from "vitest";
import { hasNewBriefFacts } from "./novelty.js";

it("skips greetings, acknowledgements, and answers already in the brief", () => {
  expect(hasNewBriefFacts("", ["Hello!", "Thanks.", "You're welcome."])).toBe(false);
  expect(
    hasNewBriefFacts("## Goal\nLaunch on Friday.\n## Open items\nBudget is 40.", [
      "When is launch?",
      "Launch on Friday.",
      "Budget is 40.",
      "OK",
    ]),
  ).toBe(false);
});

it("keeps new facts, short numeric changes, negation, and changed relationships", () => {
  const current = "Budget is 4. A follows B. Launch on Friday.";
  for (const text of [
    "Budget is 5.",
    "B follows A.",
    "Do not launch on Friday.",
    "Launch on Monday.",
    "Document saved: artifact-new",
  ]) {
    expect(hasNewBriefFacts(current, [text])).toBe(true);
  }
});
