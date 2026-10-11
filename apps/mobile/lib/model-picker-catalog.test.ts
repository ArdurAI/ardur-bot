import { expect, it } from "vitest";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

it("translates the phone's model search and connection choices", () => {
  for (const catalog of [RU_MESSAGES, ZH_MESSAGES]) {
    for (const message of [
      "Choose connection",
      "Connection settings",
      "Local server",
      "Search models",
      "No matching models",
      "Ready",
      "Connect that model first.",
      "Choose a model.",
      "Connect that model server first.",
      "This connection cannot serve that model.",
      "Unknown model for that provider",
    ]) {
      expect(catalog[message]).toBeTruthy();
      expect(catalog[message]).not.toBe(message);
    }
  }
});
