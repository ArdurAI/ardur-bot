import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

/**
 * Desktop local mode keeps control-plane secrets out of the spawned process
 * environment. The kernel keeps that block (KERN_PROCARGS2) for the life of the
 * process: a same-user command can read it, including values assigned to
 * process.env after startup, and deleting a key does not remove it. Local mode
 * therefore passes only the path of its guarded secrets file. The API and worker
 * read the values here into a plain object and never copy them onto process.env.
 *
 * The file shares the `KEY=value` shape of the stack env files. Only the keys the
 * services may hold are returned: the application database role's password (never
 * the cluster superuser's), the credential-encryption key, the session and
 * supervisor secrets, and the database URLs. An explicit environment value always
 * wins, matching loadRootEnv, except that a URL given in the secrets file wins
 * over a passwordless one in the environment.
 */
export const SERVICE_SECRET_KEYS = [
  "APP_DATABASE_PASSWORD",
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "SCREEN_PROXY_SECRET",
  "SANDBOX_SUPERVISOR_TOKEN",
  "DATABASE_URL",
  "REALTIME_DATABASE_URL",
] as const;

const secretsFileMemo = new Map<string, Record<string, string>>();

export function resetServiceSecretsMemo(): void {
  secretsFileMemo.clear();
}
export const resetServiceSecretsCache = resetServiceSecretsMemo;

export function loadServiceSecrets(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): NodeJS.ProcessEnv {
  const file = env.ARDURBOT_SECRETS_FILE?.trim();
  if (!file) return {};
  if (!path.isAbsolute(file)) throw new Error("ARDURBOT_SECRETS_FILE must be an absolute path.");
  let parsed = secretsFileMemo.get(file);
  if (parsed === undefined) {
    let raw: string;
    try {
      raw = readFile(file);
    } catch {
      throw new Error("The service secrets file could not be read.");
    }
    parsed = parse(raw);
    secretsFileMemo.set(file, parsed);
  }
  const overlay: NodeJS.ProcessEnv = {};
  for (const key of SERVICE_SECRET_KEYS) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (key === "DATABASE_URL" || key === "REALTIME_DATABASE_URL") {
      if (env[key] === undefined || isPasswordlessUrl(env[key])) {
        overlay[key] = value;
      }
    } else if (env[key] === undefined) {
      overlay[key] = value;
    }
  }
  const databaseUrlToJoin = overlay.DATABASE_URL ?? env.DATABASE_URL?.trim();
  const password = env.APP_DATABASE_PASSWORD ?? overlay.APP_DATABASE_PASSWORD;
  const databaseUrl = joinedDatabaseUrl(databaseUrlToJoin, password);
  if (databaseUrl !== undefined) overlay.DATABASE_URL = databaseUrl;
  return overlay;
}

/**
 * The object service startup should read. With nothing to overlay, this is `env`
 * itself (the dev stack is unchanged). Otherwise it is a copy: secret keys from
 * the file, and a DATABASE_URL joined with the application role's password, live
 * only on that copy.
 */
export function serviceProcessEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const overlay = loadServiceSecrets(env);
  if (Object.keys(overlay).length === 0) return env;
  return { ...env, ...overlay };
}

/**
 * The one environment secret resolvers read. With `ARDURBOT_SECRETS_FILE` set,
 * this is the secrets overlay: file values live on the returned object and are
 * not copied onto `process.env`. With no secrets file, this is `env` itself, so
 * `pnpm dev` is unchanged.
 */
export function secretEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return serviceProcessEnvironment(env);
}

function isPasswordlessUrl(value: string | undefined): boolean {
  if (!value?.trim()) return true;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") && !url.password;
  } catch {
    return false;
  }
}

/**
 * Local mode's DATABASE_URL carries no password (it is not a secret-free channel); the
 * application role's password comes from the secrets file and is joined here. A URL that
 * already has a password, or names no user, is left alone.
 */
function joinedDatabaseUrl(
  databaseUrl: string | undefined,
  password: string | undefined,
): string | undefined {
  if (!databaseUrl || !password) return undefined;
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.username ||
    url.password
  )
    return undefined;
  url.password = password;
  const joined = url.toString();
  return joined === databaseUrl ? undefined : joined;
}
