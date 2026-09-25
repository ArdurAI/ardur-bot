import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const sentence =
  "This sign-in window was replaced by a newer one. Finish signing in there, or start again.";
const surfaces = [
  "../components/integrations/DirectMcpSearch.tsx",
  "../components/integrations/IntegrationSetup.tsx",
  "../components/integrations/card/IntegrationCards.tsx",
  "../pages/McpServersOverlay.tsx",
  "../pages/McpOAuthCallback.tsx",
  "../pages/shell/message-cards.tsx",
];

it("uses the longer replaced-window sentence on every sign-in surface", () => {
  for (const surface of surfaces) {
    const source = readFileSync(new URL(surface, import.meta.url), "utf8");
    expect(source, surface).toContain(sentence);
    expect(source, surface).not.toMatch(/This sign-in window was replaced by a newer one\.`/);
  }
});

it("fills Russian and Chinese for the replaced-window sentence", () => {
  for (const locale of ["ru", "zh-CN"]) {
    const catalog = readFileSync(new URL(`./${locale}/messages.po`, import.meta.url), "utf8");
    const entry = catalog.split("\n\n").find((block) => block.includes(`msgid "${sentence}"`));
    expect(entry, locale).toBeDefined();
    const translation = entry?.split("\n").find((line) => line.startsWith("msgstr "));
    expect(translation, locale).toMatch(/^msgstr ".+"$/);
  }
});
