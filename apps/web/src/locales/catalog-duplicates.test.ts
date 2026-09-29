import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "vitest";

describe("Catalog Integrity", () => {
  it("should not contain duplicate msgids in any PO file", () => {
    const localesDir = path.join(__dirname);
    const locales = fs
      .readdirSync(localesDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    for (const locale of locales) {
      const poPath = path.join(localesDir, locale, "messages.po");
      if (fs.existsSync(poPath)) {
        const content = fs.readFileSync(poPath, "utf-8");
        const lines = content.split("\n");
        const msgids = new Set<string>();

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]?.trim();
          if (!line) continue;
          if (line.startsWith('msgid "') && line !== 'msgid ""') {
            const id = line;
            if (msgids.has(id)) {
              throw new Error(`Duplicate msgid found in ${locale}/messages.po: ${id}`);
            }
            msgids.add(id);
          }
        }
      }
    }
  });
});
