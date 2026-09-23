import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru"],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["src"],
      exclude: ["**/locales/**", "**/*.test.*"],
    },
  ],
  compileNamespace: "es",
  // Keep file references but not line numbers: every edit shifted hundreds of
  // reference lines per catalog and made upstream merges conflict on .po files.
  format: formatter({ origins: true, lineNumbers: false }),
});
