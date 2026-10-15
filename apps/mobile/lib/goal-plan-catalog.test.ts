import { describe, expect, it } from "vitest";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

// The goal project plan list renders on the phone with the owner's allowed
// actions; every sentence it shows must exist in both phone dictionaries.
// Sentences the web also renders use the web's English msgid verbatim.
describe.each([RU_MESSAGES, ZH_MESSAGES])("goal plan catalog", (catalog) => {
  it("translates every plan list sentence", () => {
    for (const message of [
      "Plan",
      "You",
      "Pending",
      "Active",
      "Blocked",
      "Done",
      "Cancelled",
      "Waiting for",
      "Cancel",
      "Reopen",
      "Mark done",
      "Could not update the plan. Try again.",
    ]) {
      expect(catalog[message]).toBeTruthy();
    }
  });
});
