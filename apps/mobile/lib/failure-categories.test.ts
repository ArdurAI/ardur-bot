import { FAILURE_CATEGORIES, runtimePinProblem } from "@ardurbot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { activateUiLocale } from "../lib/i18n";
import { RU_MESSAGES } from "../lib/locales/ru";
import { ZH_MESSAGES } from "../lib/locales/zh";
import { failureCategoryText, runtimeProblemText } from "./failure-categories";

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

  it("writes a failed run's notice in the reader's language, or as it was recorded", () => {
    const pin = {
      runtimeKind: "codex-app-server" as const,
      provider: "openai-codex",
      modelId: "gpt-6-sol",
      effort: "medium",
      credentialId: "native:codex-app-server",
      revision: 1,
    };
    const classified = runtimePinProblem(
      pin,
      "runtime-unavailable",
      "Codex's usage limit is reached. Try again after it resets.",
      "usage-limit",
    );
    const recorded = runtimePinProblem(
      pin,
      "runtime-unavailable",
      "Codex can't start: Ardur can't safely read AGENTS.md for this bot. Replace it with a plain file.",
    );
    activateUiLocale("ru");
    const notice = runtimeProblemText(classified);
    expect(notice).toBe(
      RU_MESSAGES["{runtime}'s usage limit is reached. Try again after it resets."]?.replace(
        "{runtime}",
        "Codex",
      ),
    );
    expect(notice).not.toBe(classified.reason);
    // No category: the reason keeps its own words.
    expect(runtimeProblemText(recorded)).toBe(recorded.reason);
  });

  it("names an unknown runtime in the reader's language", () => {
    expect(RU_MESSAGES["This runtime"]).toBeTruthy();
    expect(ZH_MESSAGES["This runtime"]).toBeTruthy();
    for (const locale of ["ru", "zh-CN"] as const) {
      activateUiLocale(locale);
      for (const entry of FAILURE_CATEGORIES) {
        const rendered = failureCategoryText(entry.id);
        expect(rendered, `${locale}: ${entry.id}`).not.toContain("This runtime");
        expect(rendered, `${locale}: ${entry.id}`).not.toContain("{runtime}");
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
