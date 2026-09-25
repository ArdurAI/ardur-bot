import { execFileSync, spawn } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

function isLocalDockerEndpoint(endpoint: string) {
  return endpoint.startsWith("unix://") || /^npipe:\/\/\/\/\.\/pipe\/[\w-]+$/.test(endpoint);
}

/** Provision once, migrate once, then clone a clean database for every independent trial. */
export async function provisionReplayPostgres() {
  if (process.env.DOCKER_HOST && !isLocalDockerEndpoint(process.env.DOCKER_HOST))
    throw new Error("Disposable replay requires a local Docker socket");
  // Respect an explicitly supplied endpoint; otherwise follow the installed Docker CLI context.
  if (!process.env.DOCKER_HOST) {
    const endpoint = execFileSync(
      "docker",
      ["context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}'],
      { encoding: "utf8" },
    ).trim();
    if (!isLocalDockerEndpoint(endpoint))
      throw new Error("Select a local disposable Docker endpoint");
    process.env.DOCKER_HOST = endpoint;
  }
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("scoreboard_template")
    .start();
  try {
    const databaseUrl = container.getConnectionUri();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "pnpm",
        ["--filter", "@ardurbot/db", "exec", "prisma", "migrate", "deploy"],
        {
          env: { ...process.env, DATABASE_URL: databaseUrl, REALTIME_DATABASE_URL: databaseUrl },
          stdio: "pipe",
          shell: false,
        },
      );
      let diagnostic = "";
      child.stdout.on("data", (data) => {
        diagnostic += String(data);
      });
      child.stderr.on("data", (data) => {
        diagnostic += String(data);
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Disposable schema initialization failed (${code}); ${diagnostic.replaceAll(databaseUrl, "<disposable-database>")}`,
              ),
            ),
      );
    });
    let sequence = 0;
    const sql = async (statement: string) => {
      const result = await container.exec([
        "psql",
        "-U",
        container.getUsername(),
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        statement,
      ]);
      if (result.exitCode !== 0) throw new Error("Disposable database operation failed");
    };
    return {
      async fresh() {
        const name = `scoreboard_trial_${++sequence}`;
        await sql(`CREATE DATABASE "${name}" TEMPLATE "scoreboard_template"`);
        const url = new URL(databaseUrl);
        url.pathname = `/${name}`;
        return { url: url.toString(), close: () => sql(`DROP DATABASE "${name}" WITH (FORCE)`) };
      },
      close: async () => {
        await container.stop();
      },
    };
  } catch (error) {
    await container.stop();
    throw error;
  }
}
