import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initialisePrivately,
  loadEmbeddedPostgres,
  postgresServesFolder,
  stopOwnedPostgres,
  writePersistedPort,
} from "../apps/desktop/src/local-postgres.ts";

async function main() {
  let postgres: any;
  const useEmbedded = process.env.ARDURBOT_DEV_POSTGRES === "embedded";
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

  if (useEmbedded) {
    console.log("Starting embedded Postgres...");
    const { EmbeddedPostgres } = await loadEmbeddedPostgres();
    const dataDir = path.join(rootDir, ".ardur/postgres");
    await fs.mkdir(dataDir, { recursive: true });

    postgres = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "postgres",
      password: process.env.POSTGRES_PASSWORD || "postgres",
      port: 5433,
    });

    const serves = await postgresServesFolder({
      port: 5433,
      password: process.env.POSTGRES_PASSWORD || "postgres",
      databaseDir: dataDir,
    });

    if (!serves) {
      await initialisePrivately(postgres, rootDir);
      await postgres.start();
      await writePersistedPort(path.join(dataDir, "port"), 5433);
    }
  }

  const child = spawn(
    "pnpm",
    [
      "exec",
      "turbo",
      "dev",
      "--filter=@ardurbot/api",
      "--filter=@ardurbot/worker",
      "--filter=@ardurbot/web",
      "--filter=@ardurbot/sandbox-supervisor",
      "--filter=@ardurbot/host-service",
    ],
    {
      cwd: rootDir,
      stdio: "inherit",
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    },
  );

  const onExit = async () => {
    if (postgres) {
      console.log("Stopping embedded Postgres...");
      await stopOwnedPostgres(postgres);
    }
    process.exit();
  };

  process.on("SIGINT", () => {
    child.kill("SIGINT");
    onExit();
  });

  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
    onExit();
  });

  child.on("exit", (code) => {
    if (postgres) stopOwnedPostgres(postgres);
    process.exit(code ?? 0);
  });
}
main().catch(console.error);
