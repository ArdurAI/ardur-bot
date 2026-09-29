import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { darkTokens, lightTokens, UI_APPEARANCE_STORAGE_KEY } from "@ardurbot/ui-tokens";
import { describe, expect, it } from "vitest";

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
  const root = { dataset, style: { colorScheme: "" } };
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
  it("paints the cached theme on a system set the other way", () => {
    expect(boot({ [UI_APPEARANCE_STORAGE_KEY]: "light" }, "dark")).toEqual(light);
    expect(boot({ [UI_APPEARANCE_STORAGE_KEY]: "dark" }, "light")).toEqual(dark);
  });

  it("follows the system when nothing is cached", () => {
    expect(boot({}, "light")).toEqual(light);
    expect(boot({}, "dark")).toEqual(dark);
    expect(boot({ [UI_APPEARANCE_STORAGE_KEY]: "system" }, "light")).toEqual(light);
  });

  it("ignores cached values it does not know", () => {
    const unknown = {
      [UI_APPEARANCE_STORAGE_KEY]: "sepia",
    };
    expect(boot(unknown, "dark")).toEqual(dark);
  });

  it("follows the system when storage is unavailable", () => {
    expect(boot({}, "light", true)).toEqual(light);
  });
});
