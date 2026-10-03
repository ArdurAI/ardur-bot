import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";

it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
  "translates command-tool guidance once in %s",
  async (locale) => {
    const filename = fileURLToPath(new URL(`./${locale}/messages.po`, import.meta.url));
    const source = readFileSync(filename, "utf8");
    const catalog = await formatter().parse(source, { locale, sourceLocale: "en", filename });
    for (const message of [
      "This command was not run because it exceeds 64 KB. Put code in a file and run that file.",
    ]) {
      expect(source.split(`msgid ${JSON.stringify(message)}\n`)).toHaveLength(2);
      const entry = Object.values(catalog).find((value) => value.message === message);
      expect(entry?.translation?.trim()).toBeTruthy();
      if (locale === "en") expect(entry?.translation).toBe(message);
      else expect(entry?.translation).not.toBe(message);
    }
  },
);
