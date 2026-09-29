import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { i18n } from "@lingui/core";
import { expect, it } from "vitest";

const { compileMessage } = createRequire(import.meta.resolve("@lingui/core"))(
  "@lingui/message-utils/compileMessage",
) as { compileMessage: (message: string) => never };

const PENDING = "{pending, plural, one {# suggestion to review} other {# suggestions to review}}";
const LEARNED =
  "{learned, plural, one {learned # thing this week} other {learned # things this week}}";

function catalogMessage(locale: string, msgid: string) {
  const catalog = readFileSync(
    path.join(import.meta.dirname, "../locales", locale, "messages.po"),
    "utf8",
  );
  const key = `msgid ${JSON.stringify(msgid)}\nmsgstr "`;
  const at = catalog.indexOf(key);
  expect(at, locale).toBeGreaterThanOrEqual(0);
  const start = at + key.length;
  return catalog.slice(start, catalog.indexOf('"', start));
}

function expectCounts(
  locale: string,
  pending: number,
  learned: number,
  pendingText: string,
  learnedText: string,
) {
  i18n.load(locale, {
    [PENDING]: catalogMessage(locale, PENDING),
    [LEARNED]: catalogMessage(locale, LEARNED),
  });
  i18n.activate(locale);
  expect(i18n._(PENDING, { pending })).toBe(pendingText);
  expect(i18n._(LEARNED, { learned })).toBe(learnedText);
}

it("translates suggestion and learned counts for every web locale", () => {
  i18n.setMessagesCompiler(compileMessage);
  expectCounts("en", 1, 1, "1 suggestion to review", "learned 1 thing this week");
  expectCounts("en", 3, 5, "3 suggestions to review", "learned 5 things this week");
  expectCounts("de", 1, 1, "1 Vorschlag zu prüfen", "diese Woche 1 Sache gelernt");
  expectCounts("de", 2, 2, "2 Vorschläge zu prüfen", "diese Woche 2 Sachen gelernt");
  expectCounts("es", 1, 1, "1 sugerencia para revisar", "aprendió 1 cosa esta semana");
  expectCounts("es", 5, 5, "5 sugerencias para revisar", "aprendió 5 cosas esta semana");
  expectCounts("hi", 1, 1, "समीक्षा के लिए 1 सुझाव", "इस सप्ताह 1 बात सीखी");
  expectCounts("hi", 5, 5, "समीक्षा के लिए 5 सुझाव", "इस सप्ताह 5 बातें सीखीं");
  expectCounts("ko", 1, 1, "검토할 제안 1개", "이번 주에 1가지를 학습함");
  expectCounts("ko", 5, 5, "검토할 제안 5개", "이번 주에 5가지를 학습함");
  expectCounts("pt-BR", 1, 1, "1 sugestão para revisar", "aprendeu 1 coisa esta semana");
  expectCounts("pt-BR", 5, 5, "5 sugestões para revisar", "aprendeu 5 coisas esta semana");
  expectCounts("ru", 1, 1, "1 предложение на проверку", "на этой неделе изучена 1 вещь");
  expectCounts("ru", 2, 2, "2 предложения на проверку", "на этой неделе изучены 2 вещи");
  expectCounts("ru", 5, 5, "5 предложений на проверку", "на этой неделе изучено 5 вещей");
  expectCounts("tr", 1, 1, "incelenmesi gereken 1 öneri", "bu hafta 1 şey öğrenildi");
  expectCounts("tr", 5, 5, "incelenmesi gereken 5 öneri", "bu hafta 5 şey öğrenildi");
  expectCounts("zh-CN", 1, 1, "1 条建议待审", "本周学习了 1 件事");
  expectCounts("zh-CN", 5, 5, "5 条建议待审", "本周学习了 5 件事");
});
