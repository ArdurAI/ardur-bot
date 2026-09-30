import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../e2e/fixtures/coordination-line.html",
);

describe("coordination line fixture", () => {
  it("renders CoordinationLine inside I18nProvider with member replies around it", () => {
    const source = readFileSync(fixturePath, "utf8");
    expect(source).toContain('from "@lingui/core"');
    expect(source).toContain('from "@lingui/react"');
    expect(source).toContain('setupI18n({ locale: "en", messages: { en: {} } })');
    expect(source).toMatch(/h\(\s*I18nProvider/);
    expect(source).toContain("CoordinationLine");
    expect(source).toContain('"data-testid": "message-user-bubble"');
    expect(source).toContain('"data-testid": "message-bot-bubble"');
  });
  it("uses client-side member navigation without an unauthenticated document reload", () => {
    const source = readFileSync(fixturePath, "utf8");
    expect(source).toMatch(/window\.history\.pushState\(null, "", `\/app\/\$\{botId\}`\)/);
    expect(source).not.toContain("window.location.assign");
  });
  it("exercises correction receipts and stop states through the production renderers", () => {
    const source = readFileSync(fixturePath, "utf8");
    expect(source).toContain('["requested", "confirmed", "uncertain", "checking", "replacement"]');
    expect(source).toContain('get("stop")');
    expect(source).toMatch(
      /h\(ChiefReceiptText,\s*\{\s*key: "receipt",\s*receiptKey: "exclude-member",\s*memberName: "Member",?\s*\}\)/,
    );
    expect(source).toMatch(
      /h\(ChiefReceiptText,\s*\{\s*key: "change",\s*receiptKey: "change-task",?\s*\}\)/,
    );
    expect(source).toContain("h(ChiefDispatchLine,");
    expect(source).toContain('stopState !== "replacement"');
  });
});
