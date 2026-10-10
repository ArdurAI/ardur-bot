import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
  "translates recipient and queue labels with their placeholders in %s",
  (locale) => {
    const po = readFileSync(new URL(`./${locale}/messages.po`, import.meta.url), "utf8");
    for (const [key, placeholder] of [
      ["To {names}", "{names}"],
      ["Queued: {queued}", "{queued}"],
    ]) {
      const entry = po.split(`msgid "${key}"\nmsgstr "`)[1]?.split('"')[0];
      expect(entry).toBeTruthy();
      expect(entry).toContain(placeholder);
    }
  },
);
