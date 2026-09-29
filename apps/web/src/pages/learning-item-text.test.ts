import { expect, it } from "vitest";
import { learningItemTitle } from "./learning-item-text";

const shared = "Imported memory. Review before saving.";

it("uses each item's own first line and leaves the review reason alone", () => {
  expect(
    learningItemTitle({
      type: "memory",
      rationale: shared,
      proposedContent: "\n---\nHelm chart release mechanics and gotchas\nMore detail",
    }),
  ).toBe("Helm chart release mechanics and gotchas");
  expect(
    learningItemTitle({
      type: "memory",
      rationale: shared,
      proposedContent: "Daily notes stay on this computer.",
    }),
  ).toBe("Daily notes stay on this computer.");
  expect(
    learningItemTitle({
      type: "policy-suggestion",
      rationale: "Ask before sending mail.",
    }),
  ).toBe("Ask before sending mail.");
  expect(
    learningItemTitle({
      type: "board-item",
      rationale: shared,
      boardItem: { title: "Finish the import follow-up" },
    }),
  ).toBe("Finish the import follow-up");
  expect(
    learningItemTitle({
      type: "preference",
      rationale: shared,
      typedDelta: { key: "bot.notifyOnFinish" },
    }),
  ).toBe("bot.notifyOnFinish");
});
