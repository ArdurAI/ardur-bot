import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const messages = [
  "Hermes needs a context limit of at least 64K tokens. Set it for this connection in Settings → Models.",
  "Context limit (estimated)",
  "Context limit (from the provider)",
  "Could not check the model. Try again.",
];
it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
  "translates context settings in %s",
  (locale) => {
    const catalog = readFileSync(new URL(`./${locale}/messages.po`, import.meta.url), "utf8");
    for (const message of messages) {
      const entry = catalog.split(`msgid "${message}"
msgstr "`)[1];
      expect(entry?.split('"')[0], message).toBeTruthy();
    }
  },
);
