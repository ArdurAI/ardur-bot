import type { HermesConnectionRefusal } from "@ardurbot/core";
import { HERMES_CONNECTION_POLICY } from "@ardurbot/core";
import { describe, expect, it, vi } from "vitest";
import { hermesRefusalMessage } from "./hermes-refusal";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));

describe("hermesRefusalMessage", () => {
  it("covers every refusal id with the policy's English sentence", () => {
    for (const [refusal, sentence] of Object.entries(HERMES_CONNECTION_POLICY.refusalSentences))
      expect(hermesRefusalMessage(refusal as HermesConnectionRefusal), refusal).toBe(sentence);
  });
});
