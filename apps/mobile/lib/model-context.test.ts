import { readFileSync } from "node:fs";
import { modelContextWindowLabel } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { RU_MESSAGES as ru } from "./locales/ru";
import { ZH_MESSAGES as zh } from "./locales/zh";

it.each(["default", "catalog", "metadata"] as const)(
  "translates the phone's %s context label",
  (source) => {
    const label = modelContextWindowLabel(source);
    expect(ru[label as keyof typeof ru]).toBeTruthy();
    expect(zh[label as keyof typeof zh]).toBeTruthy();
  },
);

it("uses the resolved source for both the visible phone label and accessible input name", () => {
  const screen = readFileSync(new URL("../app/models.tsx", import.meta.url), "utf8");
  expect(screen.match(/modelContextWindowLabel\(\s*contextWindowEdited/g)).toHaveLength(2);
  expect(screen).toContain("nextCredential?.contextWindowSource");
  expect(screen).toContain("contextWindowEdited ? { contextWindow: parsedContextWindow } : {}");
});
