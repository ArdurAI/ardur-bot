import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const messages = [
  "The bot stopped responding. Retry the run.",
  "Continue the interrupted run from its saved results. Check any uncertain action before repeating it.",
];
it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
  "translates stalled-run recovery in %s",
  (locale) => {
    const catalog = readFileSync(new URL(`./${locale}/messages.po`, import.meta.url), "utf8");
    for (const message of messages) {
      expect(catalog.split(`msgid "${message}"\nmsgstr "`)[1]?.split('"')[0], message).toBeTruthy();
    }
  },
);
