import { readFileSync } from "node:fs";
import { SEAL_PHASES, SEAL_SCENE_PACKS } from "@ardurbot/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  msg: (descriptor: { message: string; context: string }) => descriptor,
}));

const { sealLabelMessage } = await import("./seal-labels");

const locales = ["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"];
const labelKeys = [
  ...new Set(
    Object.values(SEAL_SCENE_PACKS).flatMap((pack) =>
      SEAL_PHASES.map((phase) => pack.phases[phase].labelKey),
    ),
  ),
];

describe("seal phase labels on the web", () => {
  it("has a catalog message for every label key a pack uses", () => {
    for (const labelKey of labelKeys) {
      expect(sealLabelMessage(labelKey), labelKey).toEqual({
        message: labelKey,
        context: "Bot seal phase",
      });
    }
  });

  it("translates every phase label in every web catalog", () => {
    for (const locale of locales) {
      const catalog = readFileSync(
        new URL(`../locales/${locale}/messages.po`, import.meta.url),
        "utf8",
      );
      for (const labelKey of labelKeys) {
        const entry = catalog.split(`msgctxt "Bot seal phase"\nmsgid "${labelKey}"\nmsgstr "`)[1];
        expect(entry, `${locale}: ${labelKey}`).toBeDefined();
        expect(entry?.split('"')[0], `${locale}: ${labelKey}`).not.toBe("");
      }
    }
  });
});
