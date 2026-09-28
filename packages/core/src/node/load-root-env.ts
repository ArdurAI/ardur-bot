import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";

export function loadRootEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      config({ path: candidate, override: false });
      // The host command guardrail denies this file to bots; it never carries the reverse.
      process.env.ARDURBOT_ENV_FILE ??= candidate;
      if (process.env.DATA_DIR && !path.isAbsolute(process.env.DATA_DIR)) {
        process.env.DATA_DIR = path.resolve(dir, process.env.DATA_DIR);
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  config();
  // dotenv's default lookup is the process cwd's .env.
  if (process.env.ARDURBOT_ENV_FILE === undefined) {
    const fallback = path.join(process.cwd(), ".env");
    if (existsSync(fallback)) process.env.ARDURBOT_ENV_FILE = fallback;
  }
}
