import { readFileSync } from "node:fs";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";

it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
  "translates blocked group model choices in %s",
  async (locale) => {
    const filename = new URL(`./${locale}/messages.po`, import.meta.url);
    const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
      locale,
      sourceLocale: "en",
      filename: filename.pathname,
    });
    for (const message of [
      "Choose a model",
      "Save the group first.",
      "This choice needs a supported computer and bot settings.",
    ]) {
      const translation = Object.values(catalog).find(
        (entry) => entry.message === message,
      )?.translation;
      expect(translation, message).toBeTruthy();
      if (locale !== "en") expect(translation, message).not.toBe(message);
    }
  },
);
