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

it("drops a leading markdown list marker from the shown title", () => {
  const stored = "- Stored line stays in the body";
  expect(
    learningItemTitle({
      type: "memory",
      rationale: shared,
      proposedContent: "- Helm chart release mechanics and gotchas",
    }),
  ).toBe("Helm chart release mechanics and gotchas");
  expect(
    learningItemTitle({
      type: "memory",
      rationale: shared,
      proposedContent: "* Keep the nightly check\n- second line",
    }),
  ).toBe("Keep the nightly check");
  expect(
    learningItemTitle({
      type: "memory",
      rationale: shared,
      proposedContent: "- \n+ The real line",
    }),
  ).toBe("The real line");
  learningItemTitle({ type: "memory", rationale: shared, proposedContent: stored });
  expect(stored).toBe("- Stored line stays in the body");
});
