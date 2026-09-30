import { COMPUTER_BOUNDARY_MESSAGES, COMPUTER_KINDS } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

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
    "Sharing",
    "Change location on desktop.",
    "Set up a container on desktop, then try again.",
    "Stopped",
    "Running",
    "Sleeping",
    "Retry",
  ]),
];
it.each([
  ["ru", RU_MESSAGES],
  ["zh-CN", ZH_MESSAGES],
] as const)("translates every execution fact and native action in %s", (locale, catalog) => {
  for (const message of messages) expect(catalog[message], `${locale}: ${message}`).toBeTruthy();
});
