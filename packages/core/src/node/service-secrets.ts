import { readFileSync } from "node:fs";
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
 * the cluster superuser's), the credential-encryption key, and the session and
 * supervisor secrets. An explicit environment value always wins, matching loadRootEnv.
 */
export const SERVICE_SECRET_KEYS = [
  "APP_DATABASE_PASSWORD",
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "SCREEN_PROXY_SECRET",
  "SANDBOX_SUPERVISOR_TOKEN",
] as const;

export function loadServiceSecrets(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (file: string) => string = (file) => readFileSync(file, "utf8"),
): NodeJS.ProcessEnv {
  const file = env.ARDURBOT_SECRETS_FILE?.trim();
  if (!file) return {};
  if (!path.isAbsolute(file)) throw new Error("ARDURBOT_SECRETS_FILE must be an absolute path.");
  let raw: string;
  try {
    raw = readFile(file);
  } catch {
    throw new Error("The service secrets file could not be read.");
  }
  const parsed = parse(raw);
  const overlay: NodeJS.ProcessEnv = {};
  for (const key of SERVICE_SECRET_KEYS) {
    const value = parsed[key];
    if (value !== undefined && env[key] === undefined) overlay[key] = value;
  }
  const databaseUrl = joinedDatabaseUrl(env, overlay);
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

/**
 * Local mode's DATABASE_URL carries no password (it is not a secret-free channel); the
 * application role's password comes from the secrets file and is joined here. A URL that
 * already has a password, or names no user, is left alone.
 */
function joinedDatabaseUrl(env: NodeJS.ProcessEnv, overlay: NodeJS.ProcessEnv): string | undefined {
  const databaseUrl = env.DATABASE_URL?.trim();
  const password = env.APP_DATABASE_PASSWORD ?? overlay.APP_DATABASE_PASSWORD;
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
