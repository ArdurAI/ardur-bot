import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ColorTokens,
  cssVariableName,
  darkTokens,
  lightTokens,
  normalizeAppearancePreference,
  persistAppearancePreference,
  renderTokensCss,
  resolveAppearance,
  resolveAppearancePreference,
  tokensForAppearance,
  UI_APPEARANCE_STORAGE_KEY,
} from "./index.js";

describe("appearance preference", () => {
  it("meets WCAG AA contrast for foreground/background pairs", () => {
    function getL(c) {
      if (!c.startsWith("#") || c.length !== 7) return 0;
      let rgb = [
        parseInt(c.slice(1, 3), 16),
        parseInt(c.slice(3, 5), 16),
        parseInt(c.slice(5, 7), 16),
      ];
      rgb = rgb.map((x) => x / 255);
      rgb = rgb.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
      return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    }
    function contrast(c1, c2) {
      const l1 = getL(c1);
      const l2 = getL(c2);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }
    const checkPairs = (tokens) => {
      const pairs = [
        ["foreground", "background"],
        ["mutedForeground", "muted"],
        ["mutedForeground", "background"],
        ["cardForeground", "card"],
        ["popoverForeground", "popover"],
        ["primaryForeground", "primary"],
        ["secondaryForeground", "secondary"],
        ["destructiveForeground", "destructive"],
        ["chatUserForeground", "chatUser"],
        ["sidebarForeground", "sidebar"],
        ["sidebarAccentForeground", "sidebarAccent"],
      ];
      for (const [fg, bg] of pairs) {
        const ratio = contrast(tokens[fg], tokens[bg]);
        expect(
          ratio,
          `${fg} on ${bg} (${tokens[fg]} on ${tokens[bg]}) ratio ${ratio}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    };
    checkPairs(lightTokens);
    checkPairs(darkTokens);
  });

  it("defaults unknown values to system", () => {
    expect(normalizeAppearancePreference(null)).toBe("system");
    expect(normalizeAppearancePreference("nope")).toBe("system");
    expect(normalizeAppearancePreference("light")).toBe("light");
  });

  it("resolves system from the platform scheme", () => {
    expect(resolveAppearance("system", "light")).toBe("light");
    expect(resolveAppearance("system", "dark")).toBe("dark");
    expect(resolveAppearance("dark", "light")).toBe("dark");
  });

  it("reads and writes storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    expect(resolveAppearancePreference({ storage })).toBe("system");
    persistAppearancePreference("light", storage);
    expect(store.get(UI_APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(resolveAppearancePreference({ storage })).toBe("light");
  });

  it("returns distinct light and dark token sets", () => {
    expect(tokensForAppearance("dark")).toBe(darkTokens);
    expect(tokensForAppearance("light")).toBe(lightTokens);
    for (const key of Object.keys(darkTokens) as (keyof ColorTokens)[]) {
      if (key === "destructiveForeground") continue;
      expect(darkTokens[key], key).not.toBe(lightTokens[key]);
    }
  });

  it("keeps user message surfaces muted, not cream invert", () => {
    const dark = tokensForAppearance("dark");
    const light = tokensForAppearance("light");
    expect(dark.secondary).not.toBe(dark.primary);
    expect(light.secondary).not.toBe(light.primary);
    expect(dark.secondaryForeground).not.toBe(dark.primaryForeground);
  });

  it("separates user bubbles from bot bubbles and the sidebar from the app", () => {
    const dark = tokensForAppearance("dark");
    const light = tokensForAppearance("light");
    expect(dark.chatUser).not.toBe(dark.muted);
    expect(light.chatUser).not.toBe(light.muted);
    expect(dark.sidebar).not.toBe(dark.background);
    expect(light.sidebar).not.toBe(light.background);
  });

  it("tolerates a throwing localStorage getter", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(resolveAppearancePreference()).toBe("system");
      persistAppearancePreference("light");
      expect(resolveAppearancePreference()).toBe("system");
    } finally {
      if (desc) Object.defineProperty(globalThis, "localStorage", desc);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

describe("tokens.css", () => {
  it("derives kebab-case variable names", () => {
    expect(cssVariableName("background")).toBe("--background");
    expect(cssVariableName("mutedForeground")).toBe("--muted-foreground");
    expect(cssVariableName("sidebarAccentForeground")).toBe("--sidebar-accent-foreground");
  });

  it("is generated from the TS palette", () => {
    const onDisk = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");
    expect(onDisk).toBe(renderTokensCss());
  });

  it("scopes light and dark under data-theme", () => {
    const css = renderTokensCss();
    expect(css).toContain('[data-theme="dark"] {\n  color-scheme: dark;');
    expect(css).toContain('[data-theme="light"] {\n  color-scheme: light;');
    expect(css).toContain(`--background: ${lightTokens.background.toLowerCase()};`);
    expect(css).toContain(`--background: ${darkTokens.background.toLowerCase()};`);
  });
});
