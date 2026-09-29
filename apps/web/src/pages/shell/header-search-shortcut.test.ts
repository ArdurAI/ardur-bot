import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("header Search button", () => {
  it("announces the Search chord, not the palette chord", () => {
    const source = readFileSync(new URL("../Shell.tsx", import.meta.url), "utf8");
    const start = source.indexOf("aria-label={t`Search`}");
    expect(start).toBeGreaterThan(-1);
    const button = source.slice(start, source.indexOf("aria-label={t`Settings`}", start));
    expect(button).toContain('aria-keyshortcuts={shortcutAria("find")}');
    expect(button).not.toContain('shortcutAria("commandPalette")');
  });
});
