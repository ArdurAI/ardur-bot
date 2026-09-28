import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const locales = ["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"];
const messages = [
  "{0} active tasks",
  "{0} peer messages waiting",
  "Conversation with {0}",
  "Latest message",
  "Updated 1m ago",
  "Status unavailable",
  "Delivered",
  "Not approved",
];

it("extracts Team presence and delivery labels into every web catalog", () => {
  for (const locale of locales) {
    const catalog = readFileSync(new URL(`./${locale}/messages.po`, import.meta.url), "utf8");
    for (const message of messages) {
      const entry = catalog.split(`msgid "${message}"\nmsgstr "`)[1];
      expect(entry, `${locale}: ${message}`).toBeDefined();
      if (locale !== "en") expect(entry?.split('"')[0], `${locale}: ${message}`).not.toBe("");
    }
  }
});
