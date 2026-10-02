import type { ChiefActivityKey } from "@ardurbot/contracts";
import { CHIEF_ACTIVITY_TEXT } from "@ardurbot/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  chiefActivityText,
  chiefDispatchSummary,
  chiefReceiptText,
  chiefResultText,
  coordinationFailureLine,
} from "./coordination";
import { resetI18nForTests, t } from "./i18n";

// Real catalogs, no i18n mock: the failure line must come from the active
// locale's catalog, with the member's name filled in and no English leaking.
describe("mobile coordination failure line locales", () => {
  afterEach(() => {
    resetI18nForTests("en");
  });

  it.each(["ru", "zh-CN"] as const)("translates every activity and result in %s", (locale) => {
    resetI18nForTests(locale);
    for (const key of Object.keys(CHIEF_ACTIVITY_TEXT) as ChiefActivityKey[]) {
      const translated = chiefActivityText({
        requestMessageId: "request",
        revision: 1,
        memberId: "worker",
        memberName: "Member",
        state: "messaged",
        reason: "eligible",
        activity: {
          revision: 1,
          runId: "run",
          delegationId: "assignment",
          attempt: 1,
          sourceSeq: 1,
          key,
          state: "active",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
      expect(translated).toBeTruthy();
      expect(translated).not.toBe(CHIEF_ACTIVITY_TEXT[key]);
    }
    expect(
      chiefResultText({
        requestMessageId: "request",
        revision: 1,
        artifactId: "draft",
        href: "artifact:draft",
        state: "draft",
      }),
    ).toBe(locale === "ru" ? "Черновик готов." : "草稿已准备好。");
    expect(t("Done — added the document to Notion.")).not.toBe(
      "Done — added the document to Notion.",
    );
    expect(t("Could not open file")).not.toBe("Could not open file");
  });

  it.each(["ru", "zh-CN"] as const)(
    "translates correction receipts and stop states in %s",
    (locale) => {
      resetI18nForTests(locale);
      const expected =
        locale === "ru"
          ? [
              "Понял — не буду поручать эту задачу Member.",
              "Понял — проверю это изменение перед следующим действием.",
              "Попросил Member остановиться",
              "Останавливаю Member",
              "Member прекратил работу",
              "Предыдущее действие могло завершиться. Проверю перед повторной попыткой.",
            ]
          : [
              "收到 — 我不会让 Member 参与这项任务。",
              "收到 — 我会在下一步操作前检查这项变更。",
              "已通知 Member 停下",
              "正在停止 Member",
              "Member 已停下",
              "上一步操作可能已完成。我会先检查，再重试。",
            ];
      expect(chiefReceiptText("exclude-member", "Member")).toBe(expected[0]);
      expect(chiefReceiptText("change-task")).toBe(expected[1]);
      const dispatch = {
        requestMessageId: "request",
        revision: 87,
        memberId: "replacement",
        memberName: "Replacement",
        state: "messaged" as const,
        reason: "eligible",
      };
      const stopping = {
        ...dispatch,
        stop: { revision: 86, memberName: "Member", state: "requested" as const },
      };
      expect(chiefDispatchSummary(stopping)).toBe(expected[2]);
      expect(chiefActivityText(stopping)).toBe(expected[3]);
      expect(
        chiefDispatchSummary({ ...stopping, stop: { ...stopping.stop, state: "confirmed" } }),
      ).toBe(expected[4]);
      expect(
        chiefDispatchSummary({ ...stopping, stop: { ...stopping.stop, state: "uncertain" } }),
      ).toBe(expected[5]);
    },
  );

  const member = (
    reasonCode: "auth" | "rate-limit" | "model-unavailable" | "stopped" | "other",
  ) => ({
    botId: "zai",
    name: "zai-bot",
    outcome: "failed" as const,
    reasonCode,
  });

  it("renders each reason code through the Russian catalog", () => {
    resetI18nForTests("ru");
    expect(coordinationFailureLine(member("auth"))).toBe(
      "zai-bot не смог ответить: аккаунт его модели требует внимания",
    );
    expect(coordinationFailureLine(member("rate-limit"))).toBe(
      "zai-bot не смог ответить: аккаунт его модели достиг лимита запросов",
    );
    expect(coordinationFailureLine(member("model-unavailable"))).toBe(
      "zai-bot не смог ответить: его модель недоступна",
    );
    expect(coordinationFailureLine(member("stopped"))).toBe("zai-bot остановился до ответа");
    expect(coordinationFailureLine(member("other"))).toBe("zai-bot не смог ответить");
  });

  it("renders each reason code through the Chinese catalog", () => {
    resetI18nForTests("zh-CN");
    expect(coordinationFailureLine(member("auth"))).toBe("zai-bot 无法回答：其模型账户需要处理");
    expect(coordinationFailureLine(member("rate-limit"))).toBe(
      "zai-bot 无法回答：其模型账户已达到速率限制",
    );
    expect(coordinationFailureLine(member("model-unavailable"))).toBe(
      "zai-bot 无法回答：其模型不可用",
    );
    expect(coordinationFailureLine(member("stopped"))).toBe("zai-bot 在回答前已停止");
    expect(coordinationFailureLine(member("other"))).toBe("zai-bot 无法回答");
  });

  it("maps an old English reason to its code before translating", () => {
    resetI18nForTests("ru");
    expect(
      coordinationFailureLine({
        botId: "zai",
        name: "zai-bot",
        outcome: "failed",
        reason: "zai-bot couldn't answer: its model account needs attention",
      }),
    ).toBe("zai-bot не смог ответить: аккаунт его модели требует внимания");
    expect(
      coordinationFailureLine({
        botId: "zai",
        name: "zai-bot",
        outcome: "failed",
        reason: "zai-bot froze mid-reply",
      }),
    ).toBe("zai-bot не смог ответить");
  });
});
