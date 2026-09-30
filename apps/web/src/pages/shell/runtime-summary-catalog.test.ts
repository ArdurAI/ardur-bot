import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMPUTER_BOUNDARY_MESSAGES, COMPUTER_KINDS } from "@ardurbot/contracts";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";

const messages = [
  ...new Set([
    ...Object.values(COMPUTER_KINDS).map((kind) => kind.location),
    ...Object.values(COMPUTER_BOUNDARY_MESSAGES),
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
    "Change location on desktop.",
    "Set up a container on desktop, then try again.",
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
