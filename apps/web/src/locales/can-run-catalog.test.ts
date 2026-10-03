import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
  "translates the visible Experimental adjustment in %s",
  (locale) => {
    const source = readFileSync(new URL(`${locale}/messages.po`, import.meta.url), "utf8");
    expect(source).toMatch(/msgid "Experimental turned on for this runtime"\nmsgstr "[^"\n]+"/);
  },
);

it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
  "translates the affected-bot policy repair sentence in %s",
  (locale) => {
    const source = readFileSync(new URL(`${locale}/messages.po`, import.meta.url), "utf8");
    expect(source).toMatch(
      /msgid "Change these bots' models first: \{0\}"\nmsgstr "[^"\n]+\{0\}[^"\n]*"/,
    );
  },
);
