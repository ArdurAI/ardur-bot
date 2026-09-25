import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

export const POSTGRES_USER = "ardurbot";
export const DATABASE_NAME = "ardurbot";
/** 5432 is the library default. 5433 is a common host Postgres and must not be reused. */
export const FORBIDDEN_PORTS = new Set([5432, 5433]);

export type EmbeddedPostgresConstructor = new (
  options: EmbeddedPostgresOptions,
) => EmbeddedPostgresLike;

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
}): Promise<EmbeddedPostgresConstructor> {
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
  const imported = (await import("embedded-postgres")) as {
    default?: EmbeddedPostgresConstructor;
  };
  const EmbeddedPostgres = imported.default;
  if (!EmbeddedPostgres) throw new Error("Embedded Postgres could not be loaded.");
  return EmbeddedPostgres;
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

export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A live `postmaster.pid` means a previous process still owns this data directory.
 * A stale pid is left for the library's `start()`, which Postgres itself clears.
 */
export async function livePostmaster(
  databaseDir: string,
  alive: (pid: number) => boolean = pidIsAlive,
): Promise<{ pid: number; port: number } | null> {
  let text: string;
  try {
    text = await readFile(path.join(databaseDir, "postmaster.pid"), "utf8");
  } catch {
    return null;
  }
  const [pidLine, recordedDir, , portLine] = text.split("\n");
  const pid = Number(pidLine);
  const port = Number(portLine);
  if (!Number.isInteger(pid) || pid <= 0 || !recordedDir) return null;
  if (path.resolve(recordedDir) !== path.resolve(databaseDir)) return null;
  if (!alive(pid)) return null;
  return { pid, port: Number.isInteger(port) && port > 0 ? port : 0 };
}

export async function stopPostmaster(pid: number): Promise<void> {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    }
    process.kill(pid, "SIGINT");
  } catch {
    return;
  }
}
