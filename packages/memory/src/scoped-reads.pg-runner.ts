// #199: Use the shared Postgres image override without changing the local default.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TEST_POSTGRES_IMAGE } from "@ardurbot/testkit/postgres-image";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const container = await new PostgreSqlContainer(TEST_POSTGRES_IMAGE)
  .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale-provider=icu --icu-locale=en-US" })
  .start();
try {
  const env = {
    ...process.env,
    DATABASE_URL: container.getConnectionUri(),
    VERIFY_DATABASE: "1",
  };
  execFileSync("pnpm", ["--filter", "@ardurbot/db", "exec", "prisma", "migrate", "deploy"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  execFileSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "packages/memory/src/scoped-reads.postgres.test.ts",
      "packages/memory/src/commit.postgres.test.ts",
      "packages/adapters/src/memory/scoped-reads-wrapper.postgres.test.ts",
      "--maxWorkers=2",
    ],
    {
      cwd: root,
      env,
      stdio: "inherit",
    },
  );
} finally {
  await container.stop();
}
