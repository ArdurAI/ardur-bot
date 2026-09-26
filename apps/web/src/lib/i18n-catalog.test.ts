import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { i18n } from "@lingui/core";
import { beforeEach, describe, expect, it } from "vitest";
import de from "../../scripts/translations-de.json";
import es from "../../scripts/translations-es.json";
import hi from "../../scripts/translations-hi.json";
import ko from "../../scripts/translations-ko.json";
import ptBR from "../../scripts/translations-pt-BR.json";
import tr from "../../scripts/translations-tr.json";
import zhCN from "../../scripts/translations-zh-CN.json";

describe("lingui catalogs", () => {
  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
  });

  it("falls back to the English source message when a translation is missing", () => {
    i18n.load("de", {});
    i18n.activate("de");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
    expect(
      i18n._({
        id: "Cancel new bot",
        message: "Cancel new bot",
      }),
    ).toBe("Cancel new bot");
  });

  it("formats ICU cron-style messages with reordered placeholders", () => {
    i18n.load("de", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "alle {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "um {timeSelect}",
    });
    i18n.activate("de");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "minutes" },
      }),
    ).toBe("alle 5 minutes");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "9:00 AM" },
      }),
    ).toBe("um 9:00 AM");

    i18n.load("ko", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "{intervalAmountSelect} {intervalUnitSelect}마다",
      "at {timeSelect}": "{timeSelect}에",
    });
    i18n.activate("ko");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "분" },
      }),
    ).toBe("5 분마다");

    i18n.load("tr", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "her {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "saat {timeSelect}",
    });
    i18n.activate("tr");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "dakika" },
      }),
    ).toBe("her 5 dakika");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "09:00" },
      }),
    ).toBe("saat 09:00");

    i18n.load("hi", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "हर {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "{timeSelect} बजे",
    });
    i18n.activate("hi");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "मिनट" },
      }),
    ).toBe("हर 5 मिनट");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "09:00" },
      }),
    ).toBe("09:00 बजे");

    i18n.load("zh-CN", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "每 {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "{timeSelect}",
      "{0, plural, one {# model} other {# models}}": "{0, plural, one {# 个模型} other {# 个模型}}",
      "{botName} · {0, plural, one {# peer} other {# peers}}":
        "{botName} · {0, plural, one {# 个同事 Bot} other {# 个同事 Bot}}",
    });
    i18n.activate("zh-CN");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "分钟" },
      }),
    ).toBe("每 5 分钟");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "09:00" },
      }),
    ).toBe("09:00");
    expect(
      i18n._({
        id: "{0, plural, one {# model} other {# models}}",
        message: "{0, plural, one {# model} other {# models}}",
        values: { 0: 1 },
      }),
    ).toBe("1 个模型");
    expect(
      i18n._({
        id: "{0, plural, one {# model} other {# models}}",
        message: "{0, plural, one {# model} other {# models}}",
        values: { 0: 3 },
      }),
    ).toBe("3 个模型");
    expect(
      i18n._({
        id: "{botName} · {0, plural, one {# peer} other {# peers}}",
        message: "{botName} · {0, plural, one {# peer} other {# peers}}",
        values: { botName: "Scout", 0: 2 },
      }),
    ).toBe("Scout · 2 个同事 Bot");

    i18n.load("es", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "cada {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "a las {timeSelect}",
    });
    i18n.activate("es");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "minutos" },
      }),
    ).toBe("cada 5 minutos");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "09:00" },
      }),
    ).toBe("a las 09:00");
  });

  it("uses seeded catalog strings for German, Korean, Turkish, Hindi, Brazilian Portuguese, Simplified Chinese, and Spanish chrome", () => {
    i18n.load("de", de as Record<string, string>);
    i18n.activate("de");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Einstellungen");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("Abbrechen");
    expect(i18n._({ id: "Search", message: "Search" })).toBe("Suchen");
    expect(i18n._({ id: "To:", message: "To:" })).toBe("An:");

    i18n.load("ko", ko as Record<string, string>);
    i18n.activate("ko");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("설정");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("취소");

    i18n.load("tr", tr as Record<string, string>);
    i18n.activate("tr");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Ayarlar");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("İptal");

    i18n.load("hi", hi as Record<string, string>);
    i18n.activate("hi");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("सेटिंग्स");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("रद्द करें");

    i18n.load("pt-BR", ptBR as Record<string, string>);
    i18n.activate("pt-BR");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Configurações");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("Cancelar");

    i18n.load("zh-CN", zhCN as Record<string, string>);
    i18n.activate("zh-CN");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("设置");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("取消");

    i18n.load("es", es as Record<string, string>);
    i18n.activate("es");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Configuración");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("Cancelar");
  });

  it("ships Simplified Chinese translations for the Chief onboarding focus card", () => {
    const catalog = readFileSync(
      fileURLToPath(new URL("../locales/zh-CN/messages.po", import.meta.url)),
      "utf8",
    );

    expect(catalog).toContain('msgid "What do you want me on first?"\nmsgstr "你想让我先做什么？"');
    expect(catalog).toContain('msgid "Day-to-day work"\nmsgstr "日常工作"');
    expect(catalog).toContain('msgid "Inbox & email"\nmsgstr "收件箱和邮件"');
    expect(catalog).toContain('msgid "Research & writing"\nmsgstr "调研和写作"');
    expect(catalog).toContain('msgid "A bit of everything"\nmsgstr "什么都做一点"');

    i18n.load("zh-CN", {
      "What do you want me on first?": "你想让我先做什么？",
      "Day-to-day work": "日常工作",
      "Inbox & email": "收件箱和邮件",
      "Research & writing": "调研和写作",
      "A bit of everything": "什么都做一点",
    });
    i18n.activate("zh-CN");
    expect(
      i18n._({
        id: "What do you want me on first?",
        message: "What do you want me on first?",
      }),
    ).toBe("你想让我先做什么？");
    expect(i18n._({ id: "Day-to-day work", message: "Day-to-day work" })).toBe("日常工作");
    expect(i18n._({ id: "Inbox & email", message: "Inbox & email" })).toBe("收件箱和邮件");
  });

  it("ships the Russian runtime catalog with translated chrome and Russian plurals", () => {
    const catalog = readFileSync(
      fileURLToPath(new URL("../locales/ru/messages.po", import.meta.url)),
      "utf8",
    );

    expect(catalog).toContain('msgid "Settings"\nmsgstr "Настройки"');
    expect(catalog).toContain('msgid "Language"\nmsgstr "Язык"');
    expect(catalog).toContain('msgid "Cancel"\nmsgstr "Отмена"');
    expect(catalog).toContain(
      'msgid "{0} runs · {1} tokens"\nmsgstr "Запусков: {0} · токенов: {1}"',
    );
    expect(catalog).toContain(
      'msgstr "{0, plural, one {# модель} few {# модели} many {# моделей} other {# модели}}"',
    );
  });

  it("names Settings, Computers, and adding a computer in the fleet guide", () => {
    const guide = readFileSync(
      fileURLToPath(new URL("../../../../docs/fleet.md", import.meta.url)),
      "utf8",
    );
    expect(guide).toContain(
      "Add a computer under Settings, Computers, then choose it here to move this computer.",
    );
    expect(guide).not.toContain("Settings, Connections");
  });

  it("ships the fleet move sentences in every catalog, with Russian and Chinese filled", () => {
    const translations: Record<string, Record<string, string>> = {
      ru: {
        "Add a computer under Settings, Computers, then choose it here to move this computer.":
          "Добавьте компьютер в разделе «Настройки», «Компьютеры», затем выберите его здесь, чтобы перенести этот компьютер.",
        "The computer changed before the move, so it stayed where it is.":
          "Компьютер изменился до переноса, поэтому он остался на месте.",
        "Deployment default (Docker)": "Развертывание по умолчанию (Docker)",
        "This moves the computer from {sourceLabel} to {destinationLabel} and replaces its files. Continue?":
          "Это переносит компьютер с {sourceLabel} на {destinationLabel} и заменяет его файлы. Продолжить?",
        "this engine": "этот механизм",
        "Moving this computer onto {hostLabel} is not available yet. Choose a saved connection or keep the current engine.":
          "Перенос этого компьютера на {hostLabel} пока недоступен. Выберите сохранённое подключение или оставьте текущий механизм.",
        "{hostLabel} is not available. Choose a saved connection or keep the current engine.":
          "{hostLabel} недоступен. Выберите сохранённое подключение или оставьте текущий механизм.",
        "Docker on this Mac": "Docker на этом Mac",
        "Docker on this computer": "Docker на этом компьютере",
      },
      "zh-CN": {
        "Add a computer under Settings, Computers, then choose it here to move this computer.":
          "在“设置”的“电脑”中添加电脑，然后在此处选择它，以移动此电脑。",
        "The computer changed before the move, so it stayed where it is.":
          "电脑在移动前已更改，因此仍留在原处。",
        "Deployment default (Docker)": "部署默认（Docker）",
        "This moves the computer from {sourceLabel} to {destinationLabel} and replaces its files. Continue?":
          "这将把电脑从 {sourceLabel} 移到 {destinationLabel}，并替换其中的文件。要继续吗？",
        "this engine": "此引擎",
        "Moving this computer onto {hostLabel} is not available yet. Choose a saved connection or keep the current engine.":
          "暂时无法将此电脑移到{hostLabel}。请选择已保存的连接，或保留当前引擎。",
        "{hostLabel} is not available. Choose a saved connection or keep the current engine.":
          "{hostLabel}尚不可用。请选择已保存的连接，或保留当前引擎。",
        "Docker on this Mac": "这台 Mac 上的 Docker",
        "Docker on this computer": "这台电脑上的 Docker",
      },
    };
    const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const locale of ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru"]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const sentence of Object.keys(translations.ru!)) {
        // Extraction writes the source reference; a hand-written id the code never asks for has none.
        expect(catalog).toMatch(new RegExp(`#: src/\\S+\\nmsgid "${literal(sentence)}"`));
        const filled = translations[locale]?.[sentence];
        if (filled) expect(catalog).toContain(`msgid "${sentence}"\nmsgstr "${filled}"`);
      }
    }
  });
});
