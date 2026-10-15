import { readFileSync } from "node:fs";
import { createCompiledCatalog } from "@lingui/cli/api";
import { i18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";

const message = "This computer · {botName}'s folder";
const labels = {
  en: "This computer · {botName}'s folder",
  de: "Dieser Computer · Ordner von {botName}",
  es: "Esta computadora · Carpeta de {botName}",
  hi: "यह कंप्यूटर · {botName} का फ़ोल्डर",
  ko: "이 컴퓨터 · {botName}의 폴더",
  "pt-BR": "Este computador · Pasta de {botName}",
  ru: "Этот компьютер · Папка {botName}",
  tr: "Bu bilgisayar · {botName} klasörü",
  "zh-CN": "这台电脑 · {botName} 的文件夹",
} as const;

it.each(Object.entries(labels))("renders the host folder owner in %s", async (locale, label) => {
  const filename = new URL(`./${locale}/messages.po`, import.meta.url);
  const entries = await formatter().parse(readFileSync(filename, "utf8"), {
    locale,
    sourceLocale: "en",
    filename: filename.pathname,
  });
  const selected = Object.entries(entries).find(([, entry]) => entry.message === message);
  expect(selected).toBeDefined();
  const [id, entry] = selected!;
  expect(entry.translation).toBe(label);
  if (typeof entry.translation !== "string") throw new Error("Missing host folder translation");
  const { source, errors } = createCompiledCatalog(
    locale,
    { [id]: entry.translation },
    {
      namespace: "json",
    },
  );
  expect(errors).toEqual([]);
  i18n.load(locale, JSON.parse(source).messages);
  i18n.activate(locale);
  expect(i18n._({ id, values: { botName: "Builder" } })).toBe(
    label.replace("{botName}", "Builder"),
  );
});
