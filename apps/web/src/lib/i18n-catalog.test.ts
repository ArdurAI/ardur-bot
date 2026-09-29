import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { i18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
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

  it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
    "catalogs the rebuilt Account card headings and actions in %s",
    async (locale) => {
      const filename = fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url));
      const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
        locale,
        sourceLocale: "en",
        filename,
      });
      for (const message of [
        "Sign-in and security",
        "Devices and sessions",
        "Save instructions",
        "Saved, but not applied everywhere.",
      ]) {
        const entry = Object.values(catalog).find((value) => value.message === message);
        expect(entry?.translation, `${locale}: ${message}`).toBeTruthy();
      }
    },
  );

  it.each(["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
    "catalogs the authenticated guided account controls in %s",
    async (locale) => {
      const filename = fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url));
      const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
        locale,
        sourceLocale: "en",
        filename,
      });
      for (const message of [
        "Return to setup",
        "Connect a model",
        "Create your first bot",
        "Create bot",
        "Finish setup",
        "Model setup is incomplete",
        "First bot not created",
        "Open Models",
        "The first bot could not be created. Try again.",
      ]) {
        const entry = Object.values(catalog).find((value) => value.message === message);
        expect(entry?.translation, `${locale}: ${message}`).toBeTruthy();
      }
    },
  );

  it.each([
    ["en", "Line 2: - [redacted] Edit or reject this line."],
    ["de", "Zeile 2: - [redacted] Diese Zeile bearbeiten oder ablehnen."],
    ["es", "Línea 2: - [redacted] Edita o rechaza esta línea."],
    ["hi", "पंक्ति 2: - [redacted] इस पंक्ति को संपादित करें या अस्वीकार करें।"],
    ["ko", "줄 2: - [redacted] 이 줄을 수정하거나 거부하세요."],
    ["pt-BR", "Linha 2: - [redacted] Edite ou rejeite esta linha."],
    ["ru", "Строка 2: - [redacted] Измените или отклоните эту строку."],
    ["tr", "Satır 2: - [redacted] Bu satırı düzenleyin veya reddedin."],
    ["zh-CN", "第 2 行：- [redacted] 请编辑或拒绝此行。"],
  ] as const)(
    "formats the credential message from the checked-in %s catalog",
    async (locale, expected) => {
      const filename = fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url));
      const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
        locale,
        sourceLocale: "en",
        filename,
      });
      const entry = Object.entries(catalog).find(
        ([, value]) => value.message === "Line {0}: {1} Edit or reject this line.",
      );
      expect(entry?.[1].translation).toBeTruthy();
      i18n.load(locale, { [entry![0]]: entry![1].translation! });
      i18n.activate(locale);
      expect(i18n._({ id: entry![0], values: { 0: 2, 1: "- [redacted]" } })).toBe(expected);
    },
  );

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

  it.each(["de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
    "translates credential classification controls in %s",
    async (locale) => {
      const filename = fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url));
      const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
        locale,
        sourceLocale: "en",
        filename,
      });
      for (const message of [
        "Credential fields",
        "Secret",
        "Secret for {key}",
        "Could not update this field. Retry.",
      ]) {
        const entry = Object.values(catalog).find((value) => value.message === message);
        expect(entry?.translation, `${locale}: ${message}`).toBeTruthy();
      }
    },
  );

  it("catalogs each failed board close sentence once, from its one shared definition", () => {
    const sentences = [
      "A board item filed by a bot could not be closed.",
      "Ardur tried five times. Close it on the Board, or check that this computer is connected.",
    ];
    for (const locale of ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru"]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const sentence of sentences) {
        const entries = catalog.split(`msgid ${JSON.stringify(sentence)}\n`).length - 1;
        expect(entries, `${locale}: ${sentence}`).toBe(1);
        expect(catalog, `${locale}: ${sentence}`).toContain(
          `#: src/lib/board-close-copy.ts\nmsgid ${JSON.stringify(sentence)}`,
        );
      }
    }
  });

  it("translates every group model control and status in each supported catalog", () => {
    const messages = [
      "Could not save group model.",
      "Model in this group",
      "Next run",
      "Same as bot",
      "Save model",
      "Using {currentId}",
      "{botName} couldn't use the model set for this group. Reconnect it or change the group model.",
      "{botName} couldn't use the model set for this group. Change the group model or check this bot's settings.",
      "This group's model is blocked by the bot or space settings. Change the destination policy or choose another group model.",
      "{0, plural, one {Also set differently in # group} other {Also set differently in # groups}}",
    ];
    for (const locale of ["de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const message of messages) {
        const escaped = message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expect(catalog, `${locale}: ${message}`).toMatch(
          new RegExp(`msgid "${escaped}"\\nmsgstr "[^"]+"`),
        );
      }
    }
  });

  it("extracts the fleet move sentences the code asks for into every catalog", () => {
    const sentences = [
      "Default computer",
      "Deployment default ({defaultLabel})",
      "Docker engine on this Mac",
      "Docker engine on this computer",
      "This moves the computer from {sourceLabel} to {destinationLabel} and replaces its files. Continue?",
    ];
    const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const locale of ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru"]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      // Extraction writes the source reference; a hand-written id the code never asks for has none.
      for (const sentence of sentences)
        expect(catalog).toMatch(new RegExp(`#: src/\\S+\\nmsgid "${literal(sentence)}"`));
      // The host-move refusal is shown as the server sent it (decided by its error code), not
      // through a hand-translated catalog copy, so it is never extracted.
      expect(catalog).not.toContain(
        "Moving a computer onto the machine running Ardur is not available yet.",
      );
    }
  });

  it("translates saved computer actions and engine diagnostics in every shipped catalog", () => {
    const sentences = [
      "Docker Desktop on this Mac",
      "Colima (default) on this Mac",
      "Installed, not running",
      "Engine not running",
      "Permission denied on the socket",
      "Socket missing",
      "Start the engine and press Test.",
      "Edit computer",
      "Remove computer",
      "Remove {0}? Its saved connection and credentials will be deleted. Past run history remains.",
      "Runs are active on this computer. Saving this connection change may interrupt them. Save anyway?",
      "Connection saved, but the test failed:",
      "Move bots first: {0}",
    ];
    for (const locale of ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru"]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const sentence of sentences) {
        const key = `msgid ${JSON.stringify(sentence)}\nmsgstr "`;
        const at = catalog.indexOf(key);
        expect(at, `${locale}: ${sentence} missing from catalog`).toBeGreaterThanOrEqual(0);
        const translated = catalog.slice(at + key.length, catalog.indexOf('"', at + key.length));
        expect(translated.trim(), `${locale}: ${sentence} must not be empty`).toBeTruthy();
      }
    }
  });

  it("translates the extension catalogue loading, empty-state, and failure guidance in every shipped catalog", () => {
    const sentences = [
      "Loading the extension catalogue…",
      "No extensions are in the built-in catalogue yet. Use Add to install an extension bundle (.mcpb or .dxt file) from this computer.",
      "Could not load the extension catalogue. Check the connection and try again.",
    ];
    for (const locale of ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru"]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const sentence of sentences) {
        const key = `msgid ${JSON.stringify(sentence)}\nmsgstr "`;
        const at = catalog.indexOf(key);
        expect(at, `${locale}: ${sentence} missing from catalog`).toBeGreaterThanOrEqual(0);
        const translated = catalog.slice(at + key.length, catalog.indexOf('"', at + key.length));
        expect(translated.trim(), `${locale}: ${sentence} must not be empty`).toBeTruthy();
      }
    }
  });

  it("ships the Team board working labels in every catalog", () => {
    // Production strips source text, so a label missing from the catalog renders as its message id.
    const sentences = ["Working on {task}", "Working on {task} for {0}"];
    for (const locale of ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru"]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const sentence of sentences) {
        expect(catalog).toContain(`#: src/pages/TeamBoard.tsx\nmsgid ${JSON.stringify(sentence)}`);
        expect(catalog).not.toContain(`msgid ${JSON.stringify(sentence)}\nmsgstr ""`);
      }
    }
  });

  it("ships both computer preparation messages in every catalog", () => {
    const sentences = ["Preparing the bot computer…", "Preparing the bot computer… {percent}%"];
    for (const locale of ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru"]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const sentence of sentences) {
        expect(catalog).toContain(`#: src/pages/Shell.tsx\nmsgid ${JSON.stringify(sentence)}`);
        expect(catalog).not.toContain(`msgid ${JSON.stringify(sentence)}\nmsgstr ""`);
      }
    }
  });

  it("translates the coordinator tools warning in every supported catalog", () => {
    const message = "{0} can't use Ardur tools — a coordinator needs tools to hand off work.";
    for (const locale of ["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      expect(catalog, `${locale}: extracted from GroupPanel`).toContain(
        `#: src/pages/GroupPanel.tsx\nmsgid ${JSON.stringify(message)}`,
      );
      const key = `msgid ${JSON.stringify(message)}\nmsgstr "`;
      const at = catalog.indexOf(key);
      expect(at, `${locale}: ${message} missing from catalog`).toBeGreaterThanOrEqual(0);
      const translated = catalog.slice(at + key.length, catalog.indexOf('"', at + key.length));
      expect(translated.trim(), `${locale}: ${message} must not be empty`).toBeTruthy();
    }
  });

  it("translates the learning reviewer strings in every shipped catalog", () => {
    const sentences = ["Learning reviewer", "The reviewer was changed in another window."];
    for (const locale of ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru"]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const sentence of sentences) {
        const key = `msgid ${JSON.stringify(sentence)}\nmsgstr "`;
        const at = catalog.indexOf(key);
        expect(at, `${locale}: ${sentence} missing from catalog`).toBeGreaterThanOrEqual(0);
        const translated = catalog.slice(at + key.length, catalog.indexOf('"', at + key.length));
        expect(translated.trim(), `${locale}: ${sentence} must not be empty`).toBeTruthy();
      }
    }
  });

  it("translates new computer placeholders in every shipped catalog", () => {
    const sentences = [
      "Booting live desktop…",
      "Computer is asleep. Open it to wake.",
      "Computer failed to boot",
      "Computer",
    ];
    for (const locale of ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru"]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const sentence of sentences) {
        expect(catalog).toContain(`msgid ${JSON.stringify(sentence)}`);
        if (locale !== "en") {
          expect(catalog).not.toContain(`msgid ${JSON.stringify(sentence)}\nmsgstr ""`);
        }
      }
    }
  });
});
