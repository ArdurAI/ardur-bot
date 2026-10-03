import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMPUTER_BOUNDARY_MESSAGES, COMPUTER_KINDS, COMPUTER_STATES } from "@ardurbot/contracts";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";

// Only strings the web renders; phone-only wording ("Sharing", "Change location on desktop.",
// "Set up a container on desktop, then try again.") is required by the phone's catalog test.
const messages = [
  ...new Set([
    ...Object.values(COMPUTER_KINDS).map((kind) => kind.location),
    ...Object.values(COMPUTER_BOUNDARY_MESSAGES),
    ...Object.values(COMPUTER_STATES),
    "Move to a container",
    "Keep current location",
    "Other locations are unavailable for {runtime}. Choose This computer.",
    "Connect the host service to choose This computer.",
    "The last update was interrupted.",
    "Release computer",
    "Release interrupted computer?",
    "Make sure nothing is still running on this computer.",
    "Nothing is still running",
    "Could not complete action",
    "Where this bot runs",
    "Only this bot",
    "Shared with team",
    "Bots share files and installed tools",
    "Computer location unavailable. Choose a supported connection.",
    "Computer location unavailable. Try again.",
    "Change location",
    "Set up a container for isolated work.",
    "Set up computer",
    "Starting",
    "Could not start",
    "Stopped",
    "Running",
    "Sleeping",
    "Retry",
  ]),
];
it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
  "translates every execution fact and action in the %s web catalog",
  async (locale) => {
    const filename = fileURLToPath(new URL(`../../locales/${locale}/messages.po`, import.meta.url));
    const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
      locale,
      sourceLocale: "en",
      filename,
    });
    for (const message of messages) {
      const entry = Object.values(catalog).find((value) => value.message === message);
      expect(entry?.translation, `${locale}: ${message}`).toBeTruthy();
    }
  },
);
