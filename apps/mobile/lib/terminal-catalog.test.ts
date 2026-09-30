import { expect, it } from "vitest";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

it.each([
  ["ru", RU_MESSAGES],
  ["zh", ZH_MESSAGES],
] as const)("translates terminal authority and confirmation in mobile %s", (_, catalog) => {
  for (const message of ["You control the computer", "Release", "End this terminal?"]) {
    expect(catalog[message]).toBeTruthy();
    expect(catalog[message]).not.toBe(message);
  }
});
