import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export interface EmbeddedPostgresOptions {
  databaseDir: string;
  port: number;
  user: string;
  password: string;
  persistent: true;
  authMethod: "scram-sha-256";
  postgresFlags: string[];
  onLog?: (message: string) => void;
  onError?: (error: unknown) => void;
}

export interface EmbeddedPostgresLike {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** The cluster's superuser, kept for maintenance; the app never runs as it. */
export const POSTGRES_USER = "ardurbot";
/** Owns the application database. Migrations, the API and the worker connect as it. */
export const APP_DATABASE_USER = "ardurbot_app";
export const DATABASE_NAME = "ardurbot";
/** 5432 is the library default. 5433 is a common host Postgres and must not be reused. */
export const FORBIDDEN_PORTS = new Set([5432, 5433]);

type EmbeddedPostgresConstructor = new (options: EmbeddedPostgresOptions) => EmbeddedPostgresLike;

export interface EmbeddedPostgresBinaries {
  EmbeddedPostgres: EmbeddedPostgresConstructor;
  /** Postgres's own control program, used only for a server that proved it serves our folder. */
  pgCtl: string;
}

/** How long a stop may take before the app kills the server process it spawned. */
const POSTGRES_STOP_WAIT_MS = 10_000;

/**
 * Packaged builds keep the platform binaries in extraResources, outside asar.
 * The directory is not named node_modules: electron-builder drops a copied
 * directory with that name. The wrapper loads the optional package with an
 * ESM dynamic import, which does not read NODE_PATH, so a resolve hook maps
 * `@embedded-postgres/*` onto that directory. NODE_PATH still covers the
 * hook's CommonJS lookup.
 * On Windows, `stop()` uses `taskkill /pid /f /t` (forced kill, not a fast
 * shutdown). The next start relies on Postgres crash recovery. That is the
 * library's behavior and is accepted here.
 * https://github.com/leinelissen/embedded-postgres
 */
let postgresModuleHook = false;

function registerPostgresModuleHook(): void {
  if (postgresModuleHook) return;
  postgresModuleHook = true;
  const nodeRequire = createRequire(import.meta.url);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith("@embedded-postgres/")) return nextResolve(specifier, context);
      try {
        const resolved = nodeRequire.resolve(specifier);
        if (path.isAbsolute(resolved)) {
          return { url: pathToFileURL(resolved).href, shortCircuit: true };
        }
      } catch {
        // Fall through when this platform's package was not staged.
      }
      return nextResolve(specifier, context);
    },
  });
}

export async function loadEmbeddedPostgres(input: {
  packaged: boolean;
  resourcesPath: string;
}): Promise<EmbeddedPostgresBinaries> {
  if (input.packaged) {
    const modules = path.join(input.resourcesPath, "postgres-modules");
    const current = process.env.NODE_PATH?.split(path.delimiter).filter(Boolean) ?? [];
    if (!current.includes(modules)) {
      process.env.NODE_PATH = [modules, ...current].join(path.delimiter);
      const nodeModule = createRequire(import.meta.url)("node:module") as {
        Module?: { _initPaths?: () => void };
        _initPaths?: () => void;
      };
      (nodeModule.Module?._initPaths ?? nodeModule._initPaths)?.();
    }
    registerPostgresModuleHook();
  }
  // The wrapper imports its platform package as it loads but reports a missing one only
  // when the server starts, so resolve both here, from where the wrapper would.
  const binaries = embeddedPostgresPackage(process.platform, process.arch);
  let wrapper: string;
  let platformPackage: string;
  let imported: { default?: EmbeddedPostgresConstructor };
  let programs: { pg_ctl?: unknown };
  try {
    wrapper = createRequire(import.meta.url).resolve("embedded-postgres");
  } catch {
    throw new MissingDatabaseBinariesError("embedded-postgres");
  }
  try {
    platformPackage = createRequire(wrapper).resolve(binaries);
  } catch {
    throw new MissingDatabaseBinariesError(binaries);
  }
  try {
    imported = (await import("embedded-postgres")) as typeof imported;
    programs = (await import(pathToFileURL(platformPackage).href)) as typeof programs;
  } catch {
    throw new MissingDatabaseBinariesError(binaries);
  }
  if (!imported.default || typeof programs.pg_ctl !== "string") {
    throw new MissingDatabaseBinariesError(binaries);
  }
  return { EmbeddedPostgres: imported.default, pgCtl: programs.pg_ctl };
}

/** The message is the sentence the window shows; the package name is for the log. */
export class MissingDatabaseBinariesError extends Error {
  constructor(readonly packageName: string) {
    super("Part of this installation is missing. Reinstall Ardur Bot.");
    this.name = "MissingDatabaseBinariesError";
  }
}

/** The optional package `embedded-postgres` imports for this computer. */
function embeddedPostgresPackage(platform: NodeJS.Platform, arch: string): string {
  return `@embedded-postgres/${platform === "win32" ? "windows" : platform}-${arch}`;
}

export async function readPersistedPort(file: string): Promise<number | null> {
  const raw = await readPrivateFile(file, 32);
  const port = Number(raw?.trim());
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || FORBIDDEN_PORTS.has(port)) {
    return null;
  }
  return port;
}

export async function writePersistedPort(file: string, port: number): Promise<void> {
  await writePrivateFile(file, `${port}\n`);
}

export function loopbackPortAvailable(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function legacyStackEnvExists(userDataDir: string): Promise<boolean> {
  try {
    const info = await lstat(path.join(userDataDir, "stack", ".env"));
    return info.isFile() || info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The library writes the superuser password to a file in `os.tmpdir()` for initdb. On Linux
 * that is the shared /tmp. For the duration of initialise() the temp folder is a new 0700
 * folder inside `parent` (the app data folder), removed afterwards. `os.tmpdir()` reads
 * TMPDIR (TEMP or TMP on Windows) on every call, and initdb inherits the same folder.
 */
export async function initialisePrivately(
  postgres: EmbeddedPostgresLike,
  parent: string,
): Promise<void> {
  const folder = await mkdtemp(path.join(parent, "initdb-"));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  for (const key of Object.keys(saved)) process.env[key] = folder;
  try {
    await postgres.initialise();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(folder, { recursive: true, force: true });
  }
}

/** The server process the library spawned (pinned version, see package.json), if any. */
export function postgresProcess(postgres: EmbeddedPostgresLike): ChildProcess | undefined {
  return (postgres as EmbeddedPostgresLike & { process?: ChildProcess }).process;
}

/**
 * Stops a server this app started. After a failed start the library still holds the
 * exited child and would wait for an `exit` event that already fired, so a child that is
 * gone is released at once. One that is still running gets the library's own stop, and is
 * killed if it has not exited within the wait. Only that child process is ever signalled.
 */
export async function stopOwnedPostgres(postgres: EmbeddedPostgresLike): Promise<void> {
  const child = postgresProcess(postgres);
  if (child && exited(child)) {
    (postgres as EmbeddedPostgresLike & { process?: ChildProcess }).process = undefined;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    postgres.stop().then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), POSTGRES_STOP_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (!stopped && child && !exited(child)) child.kill("SIGKILL");
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** The port a previous server recorded in this folder's `postmaster.pid`, if any. */
export async function recordedPostmasterPort(databaseDir: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(path.join(databaseDir, "postmaster.pid"), "utf8");
  } catch {
    return null;
  }
  const port = Number(text.split("\n")[3]);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/**
 * Whether the server answering on this port is the one serving this data folder. A pid
 * in `postmaster.pid` proves nothing: after a restart it can name any process.
 */
export async function postgresServesFolder(input: {
  port: number;
  password: string;
  databaseDir: string;
}): Promise<boolean> {
  const client = new Client({
    host: "127.0.0.1",
    port: input.port,
    user: POSTGRES_USER,
    password: input.password,
    database: "postgres",
    connectionTimeoutMillis: 3_000,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    const result = await client.query<{ data_directory?: unknown }>("SHOW data_directory");
    const served = result.rows[0]?.data_directory;
    if (typeof served !== "string") return false;
    return (await realpath(served)) === (await realpath(input.databaseDir));
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Stops a server that proved it serves this folder but that this run did not start, with
 * Postgres's own `pg_ctl`. Only the `pg_ctl` child is ever killed, if it hangs.
 */
export function stopWithPgCtl(pgCtl: string, databaseDir: string): Promise<void> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(pgCtl, ["stop", "-D", databaseDir, "-m", "fast", "-w", "-t", "10"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      resolve();
      return;
    }
    // pg_ctl itself gives up after ten seconds (-t 10).
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, POSTGRES_STOP_WAIT_MS + 5_000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
  });
}
