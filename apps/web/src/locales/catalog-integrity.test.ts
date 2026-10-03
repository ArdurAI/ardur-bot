import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAILURE_CATEGORIES } from "@ardurbot/contracts/failure-categories";
import { createCompiledCatalog, getCatalogForFile, getCatalogs } from "@lingui/cli/api";
import { getConfig } from "@lingui/conf";
import { i18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const config = getConfig({ configPath: path.join(webRoot, "lingui.config.ts") });
const catalogs = getCatalogs(config);
const locales: string[] = config.locales;

function catalogFile(locale: string) {
  return path.join(webRoot, "src", "locales", locale, "messages.po");
}

/** Message id to source text, as the English source catalog declares it. */
const sourceMessages = (async () => {
  const filename = catalogFile(config.sourceLocale);
  const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
    locale: config.sourceLocale,
    sourceLocale: config.sourceLocale,
    filename,
  });
  return new Map(Object.entries(catalog).map(([id, entry]) => [id, entry.message ?? id]));
})();

/** The id-to-text lookup the Vite plugin compiles when the app imports a catalog. */
async function translations(locale: string) {
  const file = getCatalogForFile(
    path.relative(config.rootDir, catalogFile(locale)),
    await catalogs,
  );
  if (!file) throw new Error(`No catalog is configured for ${locale}`);
  const { messages } = await file.catalog.getTranslations(locale, {
    fallbackLocales: config.fallbackLocales,
    sourceLocale: config.sourceLocale,
  });
  return messages;
}

describe("web catalogs", () => {
  it.each(locales)("pairs every msgid in the %s catalog with one msgstr", (locale) => {
    const broken = readFileSync(catalogFile(locale), "utf8")
      .split(/\n{2,}/)
      .filter((block) => {
        const lines = block.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
        if (lines.length === 0) return false;
        const ids = lines.filter((line) => line.startsWith("msgid ")).length;
        const strs = lines.filter((line) => /^msgstr(\[\d+\])? /.test(line)).length;
        return ids !== 1 || strs !== 1;
      });
    expect(broken).toEqual([]);
  });

  it.each(locales)("renders the retry time through the compiled %s catalog", async (locale) => {
    const sources = await sourceMessages;
    const id = [...sources].find(([, text]) => text === "Next try at {time}")?.[0];
    expect(id).toBeDefined();
    const { source, errors } = createCompiledCatalog(locale, await translations(locale), {
      namespace: "json",
    });
    expect(errors).toEqual([]);
    i18n.load(locale, JSON.parse(source).messages);
    i18n.activate(locale);
    const shown = i18n._(id!, { time: "09:30" });
    expect(shown).toContain("09:30");
    expect(shown).not.toContain("{time}");
    if (locale !== "en") expect(shown).not.toBe("Next try at 09:30");
  });

  it.each(locales)("renders every new safe Hermes failure in %s", async (locale) => {
    const sources = await sourceMessages;
    const { source, errors } = createCompiledCatalog(locale, await translations(locale), {
      namespace: "json",
    });
    expect(errors).toEqual([]);
    i18n.load(locale, JSON.parse(source).messages);
    i18n.activate(locale);
    const ids = new Set([
      "runtime-tool-catalog-mismatch",
      "runtime-profile-unacknowledged",
      "provider-request-too-large",
      "provider-response-too-large",
      "provider-grant-refused",
      "provider-auth-failed",
      "provider-request-failed",
    ]);
    for (const entry of FAILURE_CATEGORIES.filter((entry) => ids.has(entry.id))) {
      const id = [...sources].find(([, text]) => text === entry.message)?.[0];
      expect(id, entry.id).toBeTruthy();
      const rendered = i18n._({ id: id!, values: { runtime: "Hermes" } });
      expect(rendered, entry.id).toContain("Hermes");
      expect(rendered, entry.id).not.toContain("{runtime}");
      if (locale !== "en")
        expect(rendered, entry.id).not.toBe(entry.message.replace("{runtime}", "Hermes"));
    }
  });

  it("maps every English message to its own text", async () => {
    const sources = await sourceMessages;
    const messages = await translations(config.sourceLocale);
    const mismatched = [...sources]
      .filter(([id, source]) => messages[id] !== source)
      .map(([id, source]) => ({ source, shown: messages[id] }));
    expect(mismatched).toEqual([]);
  });

  it.each([
    ["en", "Cost unavailable", "Partially reported"],
    ["de", "Kosten nicht verfügbar", "Teilweise erfasst"],
    ["es", "Costo no disponible", "Parcialmente reportado"],
    ["hi", "लागत उपलब्ध नहीं है", "आंशिक रूप से रिपोर्ट किया गया"],
    ["ko", "비용 정보 없음", "일부만 보고됨"],
    ["pt-BR", "Custo indisponível", "Parcialmente reportado"],
    ["ru", "Стоимость недоступна", "Частично зафиксировано"],
    ["tr", "Maliyet bilgisi yok", "Kısmen raporlandı"],
    ["zh-CN", "费用不可用", "部分已报告"],
  ] as const)(
    "shows each usage period marker as its own text in %s",
    async (locale, costUnavailable, partiallyReported) => {
      const sources = await sourceMessages;
      const idOf = (text: string) => [...sources].find(([, source]) => source === text)?.[0];
      const { source, errors } = createCompiledCatalog(locale, await translations(locale), {
        namespace: "json",
      });
      expect(errors).toEqual([]);
      i18n.load(locale, JSON.parse(source).messages);
      i18n.activate(locale);
      expect(i18n._({ id: idOf("Cost unavailable") ?? "" })).toBe(costUnavailable);
      expect(i18n._({ id: idOf("Partially reported") ?? "" })).toBe(partiallyReported);
    },
  );
});
