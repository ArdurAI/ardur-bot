import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
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
 * `embedded-postgres` loads them with a dynamic import of the optional package,
 * so Node has to see that package on NODE_PATH before the wrapper is imported.
 * On Windows, `stop()` uses `taskkill /pid /f /t` (forced kill, not a fast
 * shutdown). The next start relies on Postgres crash recovery. That is the
 * library's behavior and is accepted here.
 * https://github.com/leinelissen/embedded-postgres
 */
export async function loadEmbeddedPostgres(input: {
  packaged: boolean;
  resourcesPath: string;
}): Promise<EmbeddedPostgresConstructor> {
  if (input.packaged) {
    const modules = path.join(input.resourcesPath, "postgres-modules", "node_modules");
    const current = process.env.NODE_PATH?.split(path.delimiter).filter(Boolean) ?? [];
    if (!current.includes(modules)) {
      process.env.NODE_PATH = [modules, ...current].join(path.delimiter);
      const nodeModule = createRequire(import.meta.url)("node:module") as {
        Module?: { _initPaths?: () => void };
        _initPaths?: () => void;
      };
      (nodeModule.Module?._initPaths ?? nodeModule._initPaths)?.();
    }
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
