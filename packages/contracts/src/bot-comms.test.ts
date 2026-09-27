import { describe, expect, it } from "vitest";
import {
  BOT_MESSAGE_BATCH_MAX_BODIES,
  BOT_MESSAGE_BATCH_MAX_CHARACTERS,
  botMessageNeedsWake,
  canAppendBotMessageToBatch,
} from "./bot-comms.js";

describe("goal desk delivery policy", () => {
  it.each([
    ["request", false, true],
    ["question", false, true],
    ["result", true, true],
    ["result", false, false],
    ["status", true, false],
    ["fyi", true, false],
  ] as const)("classifies %s with linked parent %s", (intent, linked, expected) => {
    expect(botMessageNeedsWake(intent, linked)).toBe(expected);
  });

  it("keeps each generation within both prompt bounds", () => {
    expect(canAppendBotMessageToBatch(BOT_MESSAGE_BATCH_MAX_BODIES - 1, 7, 1)).toBe(true);
    expect(canAppendBotMessageToBatch(BOT_MESSAGE_BATCH_MAX_BODIES, 8, 1)).toBe(false);
    expect(canAppendBotMessageToBatch(1, 7_998, 8_000)).toBe(true);
    expect(canAppendBotMessageToBatch(1, 8_000, BOT_MESSAGE_BATCH_MAX_CHARACTERS - 8_001)).toBe(
      false,
    );
  });
});
