import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../e2e/fixtures/tool-activity-disclosure.html",
);

describe("tool activity disclosure fixture", () => {
  it("renders CompactWorkRecord inside I18nProvider", () => {
    const source = readFileSync(fixturePath, "utf8");
    expect(source).toContain('from "@lingui/core"');
    expect(source).toContain('from "@lingui/react"');
    expect(source).toContain('setupI18n({ locale: "en", messages: { en: {} } })');
    expect(source).toMatch(/h\(\s*I18nProvider/);
  });
});
