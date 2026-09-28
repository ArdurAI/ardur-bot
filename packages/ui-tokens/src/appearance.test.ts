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
    function luminance(colour: string): number {
      if (!/^#[0-9a-fA-F]{6}$/.test(colour)) throw new Error(`Unsupported colour ${colour}`);
      const [r, g, b] = [1, 3, 5].map((start) => {
        const channel = Number.parseInt(colour.slice(start, start + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    function contrast(first: string, second: string): number {
      const a = luminance(first);
      const b = luminance(second);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }
    const checkPairs = (tokens: Readonly<Record<string, string>>) => {
      const pairs: ReadonlyArray<readonly [string, string]> = [
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
        const foreground = tokens[fg];
        const background = tokens[bg];
        if (!foreground || !background) throw new Error(`Missing token pair ${fg} on ${bg}`);
        const ratio = contrast(foreground, background);
        expect(
          ratio,
          `${fg} on ${bg} (${foreground} on ${background}) ratio ${ratio}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    };
    checkPairs(lightTokens as unknown as Record<string, string>);
    checkPairs(darkTokens as unknown as Record<string, string>);
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

  it("keeps the hover accent distinct from resting button surfaces", () => {
    for (const appearance of ["dark", "light"] as const) {
      const palette = tokensForAppearance(appearance);
      expect(palette.accent).not.toBe(palette.secondary);
      expect(palette.accent).not.toBe(palette.background);
    }
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
