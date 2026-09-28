import { writeFile } from "node:fs/promises";
import { darkTokens } from "@ardurbot/ui-tokens";

const source = `// Generated from @ardurbot/ui-tokens by scripts/generate-window-colors.mjs.\nexport const WINDOW_BACKGROUND_COLOR = ${JSON.stringify(darkTokens.background)};\n`;

await writeFile(new URL("../src/window-colors.generated.ts", import.meta.url), source);
