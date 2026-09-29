import { FAILURE_CATEGORIES } from "@ardurbot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { activateUiLocale } from "../lib/i18n";
import { RU_MESSAGES } from "../lib/locales/ru";
import { ZH_MESSAGES } from "../lib/locales/zh";
import { failureCategoryText } from "./failure-categories";

afterEach(() => {
  activateUiLocale("en");
});

describe("failure-category mobile completeness", () => {
  it("gives every table id a non-empty ru and zh catalog entry", () => {
    for (const entry of FAILURE_CATEGORIES) {
      expect(RU_MESSAGES[entry.message], `ru: ${entry.id}`).toBeTruthy();
      expect(ZH_MESSAGES[entry.message], `zh: ${entry.id}`).toBeTruthy();
      if (entry.groupMessage) {
        // The mobile group notices name their bot placeholder {botName} (see
        // apps/mobile/lib/group-model-notice.ts); the sentence itself is the table's.
        const groupKey = entry.groupMessage.replaceAll("{bot}", "{botName}");
        expect(RU_MESSAGES[groupKey], `ru group: ${entry.id}`).toBeTruthy();
        expect(ZH_MESSAGES[groupKey], `zh group: ${entry.id}`).toBeTruthy();
      }
    }
  });

  it("renders every category in Russian with no English left", () => {
    activateUiLocale("ru");
    for (const entry of FAILURE_CATEGORIES) {
      const rendered = failureCategoryText(entry.id, { runtime: "Claude Code" });
      expect(rendered, entry.id).not.toBe(entry.message.replace("{runtime}", "Claude Code"));
      expect(rendered, entry.id).toContain("Claude Code");
    }
  });
});
