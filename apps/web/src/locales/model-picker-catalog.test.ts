import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("translates connection choices in all nine web catalogs", () => {
  for (const locale of ["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"]) {
    const source = readFileSync(new URL(`./${locale}/messages.po`, import.meta.url), "utf8");
    for (const message of [
      "Choose connection",
      "Connection settings",
      "Local server",
      "Connect that model first.",
      "Choose a model.",
      "Connect that model server first.",
      "This connection cannot serve that model.",
      "Unknown model for that provider",
    ]) {
      const match = source.match(
        new RegExp(`msgid "${message.replaceAll(".", "\\.")}"\\nmsgstr "([^"]+)"`),
      );
      expect(match?.[1], `${locale}: ${message}`).toBeTruthy();
      if (locale !== "en") expect(match?.[1]).not.toBe(message);
    }
  }
});
