import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const labels = [
  "Last 7 days",
  "Completed",
  "Failed",
  "Cancelled",
  "Success",
  "First reply",
  "Not measured",
  "Last failure",
  "No runs yet",
  "This bot",
  "{count} measured runs",
];

it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
  "translates the recorded runtime reliability labels in %s",
  (locale) => {
    const source = readFileSync(new URL(`${locale}/messages.po`, import.meta.url), "utf8");
    for (const label of labels) {
      const entry = source.split("\n\n").find((block) => block.includes(`msgid "${label}"\n`));
      expect(entry, label).toMatch(/msgstr "[^"\n]+"/);
    }
  },
);
