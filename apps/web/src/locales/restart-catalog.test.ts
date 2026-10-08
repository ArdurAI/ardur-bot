import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const messages = [
  "Updating — your bots will continue after the update",
  "This run continued in a new session after a restart.",
  "Update paused because a bot is still working. Try again.",
  "This action may already have happened. Check its outcome before trying again.",
  "Bot work is still paused after the update. Try again.",
];
it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
  "translates restart state in %s",
  (locale) => {
    const catalog = readFileSync(new URL(`./${locale}/messages.po`, import.meta.url), "utf8");
    for (const message of messages) {
      expect(catalog.split(`msgid "${message}"\nmsgstr "`)[1]?.split('"')[0], message).toBeTruthy();
    }
  },
);
