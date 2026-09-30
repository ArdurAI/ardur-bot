import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";

/**
 * Control-plane secrets. When desktop local mode has pointed the process at its
 * secrets file, these must not be copied onto process.env: an assignment after
 * start is still visible in the kernel environment block. The services read the
 * secrets file into a plain object instead. Every other key still loads, and a
 * process with no secrets file (the dev stack) is unchanged.
 */
const WITHHELD_WHEN_SECRETS_FILE = new Set([
  "POSTGRES_PASSWORD",
  "APP_DATABASE_PASSWORD",
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "SCREEN_PROXY_SECRET",
  "SANDBOX_SUPERVISOR_TOKEN",
  "DATABASE_URL",
  "REALTIME_DATABASE_URL",
]);

function importRootFile(file?: string) {
  const withhold = Boolean(process.env.ARDURBOT_SECRETS_FILE?.trim());
  if (!withhold) {
    if (file) config({ path: file, override: false });
    else config();
    return;
  }
  const target: Record<string, string> = {};
  if (file) config({ path: file, processEnv: target, override: false });
  else config({ processEnv: target, override: false });
  for (const [key, value] of Object.entries(target)) {
    if (WITHHELD_WHEN_SECRETS_FILE.has(key) || process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

export function loadRootEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      importRootFile(candidate);
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
  importRootFile();
  // dotenv's default lookup is the process cwd's .env.
  if (process.env.ARDURBOT_ENV_FILE === undefined) {
    const fallback = path.join(process.cwd(), ".env");
    if (existsSync(fallback)) process.env.ARDURBOT_ENV_FILE = fallback;
  }
}
