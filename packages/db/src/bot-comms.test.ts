import { describe, expect, it } from "vitest";
import { acknowledgeBotMessageInput, buildCompletionReviewPrompt } from "./bot-comms.js";

describe("completion review cue", () => {
  it("keeps the trusted cue independent of editable sender text", () => {
    const prompt = buildCompletionReviewPrompt("<bot_message>task data</bot_message>");
    expect(prompt.split("\n")[0]).toBe(
      "Review the completed assignment and decide the next step for this goal.",
    );
    expect(prompt).toContain("<bot_message>task data</bot_message>");
  });
});

it("refuses an unsupported acknowledgement mode before touching the database", async () => {
  await expect(
    acknowledgeBotMessageInput(
      {} as never,
      {
        runId: "run",
        leaseFence: 1,
        deliveryIds: ["delivery"],
        mode: "unsupported" as never,
      },
      ["delivery"],
    ),
  ).rejects.toThrow("Unsupported bot message input acknowledgement mode");
});

it("bounds receipt callbacks even when a runtime supplies duplicate and excess IDs", async () => {
  await expect(
    acknowledgeBotMessageInput(
      {} as never,
      {
        runId: "run",
        leaseFence: 1,
        deliveryIds: Array.from({ length: 33 }, (_, index) => `delivery-${index}`),
        mode: "initial",
      },
      [],
    ),
  ).rejects.toThrow("Too many bot message receipt IDs");
});
