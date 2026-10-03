import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("extracts and translates both command-line device labels in all web catalogs", () => {
  for (const locale of ["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"]) {
    const catalog = readFileSync(new URL(`./${locale}/messages.po`, import.meta.url), "utf8");
    for (const message of ["Copy pairing code", "Command line"]) {
      const entry = catalog.split(`msgid "${message}"\nmsgstr "`)[1];
      expect(entry?.split('"')[0], `${locale}: ${message}`).toBeTruthy();
    }
  }
});
