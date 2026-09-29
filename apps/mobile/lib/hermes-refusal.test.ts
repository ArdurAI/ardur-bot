import type { HermesConnectionRefusal } from "@ardurbot/core";
import { HERMES_CONNECTION_POLICY } from "@ardurbot/core";
import { describe, expect, it } from "vitest";
import { hermesRefusalMessage } from "./hermes-refusal";

describe("hermesRefusalMessage", () => {
  it("covers every refusal id with the policy's English sentence", () => {
    const t = (message: string) => message;
    for (const [refusal, sentence] of Object.entries(HERMES_CONNECTION_POLICY.refusalSentences))
      expect(hermesRefusalMessage(refusal as HermesConnectionRefusal, t), refusal).toBe(sentence);
  });

  it("routes every sentence through the locale translator", () => {
    const translated = new Set<string>();
    const t = (message: string) => {
      translated.add(message);
      return `ru:${message}`;
    };
    for (const refusal of Object.keys(HERMES_CONNECTION_POLICY.refusalSentences))
      expect(hermesRefusalMessage(refusal as HermesConnectionRefusal, t)).toMatch(/^ru:/);
    expect(translated.size).toBe(Object.keys(HERMES_CONNECTION_POLICY.refusalSentences).length);
  });
});
