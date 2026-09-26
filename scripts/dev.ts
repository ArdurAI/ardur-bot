import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EmbeddedPostgresBinaries,
  EmbeddedPostgresLike,
} from "../apps/desktop/src/local-postgres.js";

export const TURBO_ARGS = [
  "exec",
  "turbo",
  "dev",
  "--filter=@ardurbot/api",
  "--filter=@ardurbot/worker",
  "--filter=@ardurbot/web",
  "--filter=@ardurbot/sandbox-supervisor",
  "--filter=@ardurbot/host-service",
];

export interface DevOptions {
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  spawn?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      stdio: "inherit" | "pipe" | "ignore";
      env: NodeJS.ProcessEnv;
    },
  ) => ChildProcess;
  loadPostgres?: () => Promise<EmbeddedPostgresBinaries>;
  allocatePort?: () => Promise<number>;
  postgresServesFolder?: (input: {
    port: number;
    password: string;
    databaseDir: string;
    timeoutMs?: number;
  }) => Promise<boolean>;
  initialisePrivately?: (postgres: EmbeddedPostgresLike, parent: string) => Promise<void>;
  ensureDatabase?: (input: {
    adminUrl: string;
    databaseUrl: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  stopOwnedPostgres?: (postgres: EmbeddedPostgresLike) => Promise<void>;
  writePersistedPort?: (file: string, port: number) => Promise<void>;
  exitOnChildExit?: boolean;
}

export async function runDev(options: DevOptions = {}): Promise<ChildProcess> {
  const env = options.env ?? process.env;
  const useEmbedded = env.ARDURBOT_DEV_POSTGRES === "embedded";
  const rootDir = options.rootDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const spawnFn = options.spawn ?? nodeSpawn;

  let postgres: EmbeddedPostgresLike | undefined;
  let stopOwnedPostgresFn: ((p: EmbeddedPostgresLike) => Promise<void>) | undefined;
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };

  if (useEmbedded) {
    const localPostgres = await import("../apps/desktop/src/local-postgres.js");
    const localStack = await import("../apps/desktop/src/local-stack.js");
    const migrateSql = await import("../packages/db/src/migrate-sql.js");

    const loadPostgres =
      options.loadPostgres ??
      (() =>
        localPostgres.loadEmbeddedPostgres({
          packaged: false,
          resourcesPath: "",
        }));
    const allocatePort = options.allocatePort ?? localStack.allocateLoopbackPort;
    const postgresServes = options.postgresServesFolder ?? localPostgres.postgresServesFolder;
    const initialisePrivately = options.initialisePrivately ?? localPostgres.initialisePrivately;
    const ensureDatabase = options.ensureDatabase ?? migrateSql.ensureApplicationDatabase;
    const stopOwned = options.stopOwnedPostgres ?? localPostgres.stopOwnedPostgres;
    const writePersistedPort = options.writePersistedPort ?? localPostgres.writePersistedPort;
    stopOwnedPostgresFn = stopOwned;

    const dataDir = path.join(rootDir, ".ardur", "dev-postgres");
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

    const rawPort = env.ARDURBOT_DEV_POSTGRES_PORT
      ? Number(env.ARDURBOT_DEV_POSTGRES_PORT)
      : undefined;
    let port: number;
    if (
      rawPort &&
      Number.isInteger(rawPort) &&
      rawPort !== 5433 &&
      rawPort >= 1024 &&
      rawPort <= 65535
    ) {
      port = rawPort;
    } else {
      let candidate = await allocatePort();
      while (candidate === 5433 || candidate === 5432) {
        candidate = await allocatePort();
      }
      port = candidate;
    }

    const credentialsPath = path.join(dataDir, "credentials.json");
    let adminPassword = "";
    let appPassword = "";
    try {
      const content = await fs.readFile(credentialsPath, "utf8");
      const parsed = JSON.parse(content) as { adminPassword?: string; appPassword?: string };
      if (
        typeof parsed.adminPassword === "string" &&
        typeof parsed.appPassword === "string" &&
        parsed.adminPassword.length > 0 &&
        parsed.appPassword.length > 0 &&
        parsed.adminPassword !== parsed.appPassword
      ) {
        adminPassword = parsed.adminPassword;
        appPassword = parsed.appPassword;
      }
    } catch {
      // Credentials missing or invalid; generate new values below.
    }

    if (!adminPassword || !appPassword) {
      adminPassword = randomBytes(24).toString("hex");
      appPassword = randomBytes(24).toString("hex");
      while (appPassword === adminPassword) {
        appPassword = randomBytes(24).toString("hex");
      }
      await fs.writeFile(credentialsPath, JSON.stringify({ adminPassword, appPassword }, null, 2), {
        mode: 0o600,
        encoding: "utf8",
      });
      if (process.platform !== "win32") {
        await fs.chmod(credentialsPath, 0o600).catch(() => undefined);
      }
    }

    const adminUrl = `postgres://${localPostgres.POSTGRES_USER}:${encodeURIComponent(adminPassword)}@127.0.0.1:${port}/postgres`;
    const databaseUrl = `postgres://${localPostgres.APP_DATABASE_USER}:${encodeURIComponent(appPassword)}@127.0.0.1:${port}/${localPostgres.DATABASE_NAME}`;

    const { EmbeddedPostgres } = await loadPostgres();
    postgres = new EmbeddedPostgres({
      databaseDir: dataDir,
      port,
      user: localPostgres.POSTGRES_USER,
      password: adminPassword,
      persistent: true,
      authMethod: "scram-sha-256",
      postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
    });

    const serves = await postgresServes({
      port,
      password: adminPassword,
      databaseDir: dataDir,
    });

    if (!serves) {
      const pgVersionFile = path.join(dataDir, "PG_VERSION");
      let pgVersionExists = false;
      try {
        await fs.stat(pgVersionFile);
        pgVersionExists = true;
      } catch {
        pgVersionExists = false;
      }

      if (!pgVersionExists) {
        await initialisePrivately(postgres, path.join(rootDir, ".ardur"));
      }
      await postgres.start();
      await writePersistedPort(path.join(dataDir, "port"), port);
    }

    await ensureDatabase({ adminUrl, databaseUrl });

    childEnv.DATABASE_URL = databaseUrl;
    childEnv.REALTIME_DATABASE_URL = databaseUrl;
  }

  const child = spawnFn("pnpm", TURBO_ARGS, {
    cwd: rootDir,
    stdio: "inherit",
    env: childEnv,
  });

  let stopping = false;
  const onExit = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (postgres && stopOwnedPostgresFn) {
      await stopOwnedPostgresFn(postgres);
    }
  };

  const sigintHandler = (): void => {
    child.kill("SIGINT");
    void onExit().then(() => {
      process.exit();
    });
  };

  const sigtermHandler = (): void => {
    child.kill("SIGTERM");
    void onExit().then(() => {
      process.exit();
    });
  };

  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  child.on("exit", (code) => {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
    void onExit().then(() => {
      if (options.exitOnChildExit ?? true) {
        process.exit(code ?? 0);
      }
    });
  });

  return child;
}

export { runDev as dev };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDev().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
