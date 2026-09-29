import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { textDirectionForLocale } from "@ardurbot/core";
import { darkTokens, lightTokens, UI_APPEARANCE_STORAGE_KEY } from "@ardurbot/ui-tokens";
import { describe, expect, it } from "vitest";
import { RESOLVED_UI_LOCALE_STORAGE_KEY, UI_LOCALES } from "./ui-locale";

const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
const bootScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

/** Runs the inline script the way the browser does before the first paint. */
function boot(stored: Record<string, string>, system: "light" | "dark", storageFails = false) {
  const values = new Map(Object.entries(stored));
  const meta = {
    content: darkTokens.background.toLowerCase(),
    setAttribute(name: string, value: string) {
      if (name === "content") this.content = value;
    },
  };
  const dataset: Record<string, string> = {};
  const root = { lang: "en", dataset, style: { colorScheme: "" } };
  vm.runInNewContext(bootScript, {
    localStorage: {
      getItem(key: string) {
        if (storageFails) throw new Error("storage is off");
        return values.get(key) ?? null;
      },
    },
    matchMedia: (query: string) => ({
      matches: query === "(prefers-color-scheme: light)" && system === "light",
    }),
    document: {
      documentElement: root,
      querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? meta : null),
    },
  });
  return {
    theme: root.dataset.theme,
    colorScheme: root.style.colorScheme,
    themeColor: meta.content,
    lang: root.lang,
  };
}

const light = {
  theme: "light",
  colorScheme: "light",
  themeColor: lightTokens.background.toLowerCase(),
};
const dark = {
  theme: "dark",
  colorScheme: "dark",
  themeColor: darkTokens.background.toLowerCase(),
};

// index.html sets theme-color before any module loads, so it cannot import the
// tokens; this pins its inline fallbacks to the shared palette instead.
describe("index.html theme bootstrap", () => {
  it("uses the shared background tokens for theme-color", () => {
    expect(html).toContain(
      `<meta name="theme-color" content="${darkTokens.background.toLowerCase()}" />`,
    );
    expect(html).toContain(
      `theme === "light" ? "${lightTokens.background.toLowerCase()}" : "${darkTokens.background.toLowerCase()}"`,
    );
  });
});

describe("index.html boot script", () => {
  it("paints the cached theme and language on a system set the other way", () => {
    const cached = { [RESOLVED_UI_LOCALE_STORAGE_KEY]: "de" };
    expect(boot({ ...cached, [UI_APPEARANCE_STORAGE_KEY]: "light" }, "dark")).toEqual({
      ...light,
      lang: "de",
    });
    expect(boot({ ...cached, [UI_APPEARANCE_STORAGE_KEY]: "dark" }, "light")).toEqual({
      ...dark,
      lang: "de",
    });
  });

  it("follows the system and keeps English when nothing is cached", () => {
    expect(boot({}, "light")).toEqual({ ...light, lang: "en" });
    expect(boot({}, "dark")).toEqual({ ...dark, lang: "en" });
    expect(boot({ [UI_APPEARANCE_STORAGE_KEY]: "system" }, "light")).toEqual({
      ...light,
      lang: "en",
    });
  });

  it("ignores cached values it does not know", () => {
    const unknown = {
      [UI_APPEARANCE_STORAGE_KEY]: "sepia",
      [RESOLVED_UI_LOCALE_STORAGE_KEY]: "xx-secret",
    };
    expect(boot(unknown, "dark")).toEqual({ ...dark, lang: "en" });
  });

  it("follows the system and keeps English when storage is unavailable", () => {
    expect(boot({}, "light", true)).toEqual({ ...light, lang: "en" });
  });

  it("sets every UI language, all of them left to right", () => {
    for (const locale of UI_LOCALES) {
      expect(boot({ [RESOLVED_UI_LOCALE_STORAGE_KEY]: locale }, "dark").lang).toBe(locale);
      // The script sets only `lang` before paint; a right-to-left language needs `dir` there too.
      expect(textDirectionForLocale(locale)).toBe("ltr");
    }
  });
});
