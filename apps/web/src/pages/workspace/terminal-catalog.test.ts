import { readFileSync } from "node:fs";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";

const messages = ["You control the computer", "Release", "End this terminal?"];

it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
  "translates terminal authority and confirmation in %s",
  async (locale) => {
    const filename = new URL(`../../locales/${locale}/messages.po`, import.meta.url);
    const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
      locale,
      sourceLocale: "en",
      filename: filename.pathname,
    });
    for (const message of messages) {
      const entry = Object.values(catalog).find((value) => value.message === message);
      expect(entry?.translation, `${locale}: ${message}`).toBeTruthy();
    }
  },
);
