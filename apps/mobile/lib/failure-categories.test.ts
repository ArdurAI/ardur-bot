import { FAILURE_CATEGORIES, failureCategory, runtimePinProblem } from "@ardurbot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { activateUiLocale } from "../lib/i18n";
import { RU_MESSAGES } from "../lib/locales/ru";
import { ZH_MESSAGES } from "../lib/locales/zh";
import { failureCategoryText, runtimeProblemText } from "./failure-categories";

function pinFor() {
  return {
    runtimeKind: "codex-app-server" as const,
    provider: "openai-codex",
    modelId: "gpt-6-sol",
    effort: "medium",
    credentialId: "native:codex-app-server",
    revision: 1,
  };
}

afterEach(() => {
  activateUiLocale("en");
});

describe("failure-category mobile completeness", () => {
  it.each(["ru", "zh-CN"] as const)("translates a Hermes session-start failure in %s", (locale) => {
    activateUiLocale(locale);
    const problem = runtimePinProblem(
      { ...pinFor(), runtimeKind: "hermes" },
      "runtime-unavailable",
      "Hermes could not start a session. Check the runtime and try again.",
      "session-start-failed",
    );
    const text = runtimeProblemText(problem);
    expect(text).toContain("Hermes");
    expect(text).not.toContain("{runtime}");
    expect(text).not.toBe(problem.reason);
  });
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
    expect(RU_MESSAGES["This bot"]).toBeTruthy();
    expect(ZH_MESSAGES["This bot"]).toBeTruthy();
    for (const locale of ["ru", "zh-CN"] as const) {
      activateUiLocale(locale);
      for (const entry of FAILURE_CATEGORIES) {
        const rendered = failureCategoryText(entry.id);
        expect(rendered, `${locale}: ${entry.id}`).not.toContain("This runtime");
        expect(rendered, `${locale}: ${entry.id}`).not.toContain("{runtime}");
        expect(rendered, `${locale}: ${entry.id}`).not.toContain("{bot}");
      }
    }
  });

  it("renders every category in Russian with no English left", () => {
    activateUiLocale("ru");
    for (const entry of FAILURE_CATEGORIES) {
      const rendered = failureCategoryText(entry.id, {
        runtime: "Claude Code",
        bot: "Reviewer",
      });
      expect(rendered, entry.id).not.toBe(
        entry.message.replaceAll("{runtime}", "Claude Code").replaceAll("{bot}", "Reviewer"),
      );
      // A sentence shows each name it uses, and no placeholder is left unfilled.
      if (entry.message.includes("{runtime}")) expect(rendered, entry.id).toContain("Claude Code");
      if (entry.message.includes("{bot}")) expect(rendered, entry.id).toContain("Reviewer");
    }
  });

  it.each([
    "experimental-off",
    "computer-unsupported",
    "destinations-bot",
    "destinations-space",
  ] as const)("fills the refusal sentence %s with the bot's name", (id) => {
    const entry = failureCategory(id);
    expect(entry.action.kind).toBeTruthy();
    expect(
      runtimeProblemText(
        runtimePinProblem(pinFor(), "locality-denied", "recorded", id),
        "Reviewer",
      ),
    ).toBe(entry.message.replaceAll("{runtime}", "Codex").replaceAll("{bot}", "Reviewer"));
    // The category's further actions travel beside the first.
    expect(entry.more, id).toEqual([{ kind: "open-settings", target: "model-pin" }]);
  });

  it("keeps an unclassified refusal's recorded words", () => {
    expect(
      runtimeProblemText(
        runtimePinProblem(pinFor(), "locality-denied", "recorded words", undefined),
      ),
    ).toBe("recorded words");
  });
});
