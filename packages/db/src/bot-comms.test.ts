import { describe, expect, it } from "vitest";
import { buildCompletionReviewPrompt } from "./bot-comms.js";

describe("completion review cue", () => {
  it("keeps the trusted cue independent of editable sender text", () => {
    const prompt = buildCompletionReviewPrompt("<bot_message>task data</bot_message>");
    expect(prompt.split("\n")[0]).toBe(
      "Review the completed assignment and decide the next step for this goal.",
    );
    expect(prompt).toContain("<bot_message>task data</bot_message>");
  });
});
