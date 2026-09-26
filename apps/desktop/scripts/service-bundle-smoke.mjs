import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleServices } from "./bundle-services.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const FORBIDDEN_PORTS = new Set([5432, 5433]);

export const SMOKE_SKIP_REASON =
  "No Postgres service is configured. Set ARDURBOT_SMOKE_DATABASE_URL to a disposable database, or ARDURBOT_SMOKE_EMBEDDED=1 to start a temporary embedded database.";

export function smokeSkipReason(env = process.env) {
  if (env.ARDURBOT_SMOKE_DATABASE_URL?.trim() || env.ARDURBOT_SMOKE_EMBEDDED === "1") return null;
  return SMOKE_SKIP_REASON;
}

function redact(text) {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function allocatePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await freePort();
    if (!FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error("No loopback port is free.");
}

function assertOutsideRepo(directory) {
  const root = path.resolve(repoRoot);
  const target = path.resolve(directory);
  if (target === root || target.startsWith(`${root}${path.sep}`)) {
    throw new Error("The smoke copy must be outside the repository.");
  }
}

function databasePort(databaseUrl) {
  const port = Number(new URL(databaseUrl).port || 5432);
  if (FORBIDDEN_PORTS.has(port)) {
    throw new Error("The smoke database must not use port 5432 or 5433.");
  }
  return port;
}

async function runNode(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const status = await new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  if (status !== 0) {
    throw new Error(redact(output || `command exited ${status}`));
  }
  return output;
}

async function migrate(databaseUrl) {
  const tsxLoader = createRequire(path.join(repoRoot, "package.json")).resolve("tsx");
  const migrateModule = pathToFileURL(path.join(repoRoot, "packages/db/src/migrate-sql.ts")).href;
  const output = await runNode(
    [
      "--import",
      tsxLoader,
      "--input-type=module",
      "-e",
      `import { ensureApplicationDatabase, applySqlMigrationsToDatabase } from ${JSON.stringify(migrateModule)};
       await ensureApplicationDatabase(process.env.SMOKE_DATABASE_URL);
       const result = await applySqlMigrationsToDatabase({
         connectionString: process.env.SMOKE_DATABASE_URL,
         migrationsDir: process.env.SMOKE_MIGRATIONS_DIR,
       });
       process.stdout.write("applied " + result.applied.length + "\\n");`,
    ],
    {
      ...process.env,
      SMOKE_DATABASE_URL: databaseUrl,
      SMOKE_MIGRATIONS_DIR: path.join(repoRoot, "packages/db/prisma/migrations"),
    },
  );
  process.stdout.write(redact(output));
}

function startService(entry, env, cwd) {
  const child = spawn(
    process.execPath,
    ["--import", path.join(cwd, "services-loader.mjs"), entry],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const append = (chunk) => {
    output += chunk.toString();
    if (output.length > 200_000) output = output.slice(-100_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return {
    child,
    text: () => output,
  };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const result = await predicate();
    if (result === "stop") return false;
    if (result) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function stopChild(handle) {
  const child = handle?.child;
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function runSmoke(env = process.env) {
  const reason = smokeSkipReason(env);
  if (reason) {
    process.stdout.write(`${reason}\n`);
    return;
  }
  const copyDir =
    env.ARDURBOT_SMOKE_SERVICES_DIR ?? (await mkdtemp(path.join(tmpdir(), "ardurbot-services-")));
  assertOutsideRepo(copyDir);
  let postgres;
  let databaseDir;
  const handles = [];
  try {
    const staged = await bundleServices();
    await rm(copyDir, { recursive: true, force: true });
    await cp(staged.servicesDir, copyDir, { recursive: true, verbatimSymlinks: false });
    assertOutsideRepo(copyDir);
    const dataDir = path.join(copyDir, "data");
    await mkdir(dataDir, { recursive: true });
    let databaseUrl = env.ARDURBOT_SMOKE_DATABASE_URL?.trim();
    if (!databaseUrl) {
      databaseDir =
        env.ARDURBOT_SMOKE_DATA_DIR ?? (await mkdtemp(path.join(tmpdir(), "ardurbot-pg-")));
      assertOutsideRepo(databaseDir);
      await rm(databaseDir, { recursive: true, force: true });
      await mkdir(databaseDir, { recursive: true });
      const port = await allocatePort();
      const password = randomBytes(16).toString("hex");
      const { default: EmbeddedPostgres } = await import("embedded-postgres");
      postgres = new EmbeddedPostgres({
        databaseDir,
        port,
        user: "ardurbot",
        password,
        persistent: true,
        authMethod: "scram-sha-256",
        postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
      });
      await postgres.initialise();
      await postgres.start();
      databaseUrl = `postgres://ardurbot:${password}@127.0.0.1:${port}/ardurbot`;
    }
    databasePort(databaseUrl);
    await migrate(databaseUrl);
    const apiPort = await allocatePort();
    const origin = `http://127.0.0.1:${apiPort}`;
    const serviceEnv = {
      PATH: env.PATH ?? "",
      NODE_ENV: "production",
      NODE_PATH: path.join(copyDir, "modules"),
      DATABASE_URL: databaseUrl,
      DATA_DIR: dataDir,
      SANDBOX_PROVIDER: "desktop",
      BETTER_AUTH_SECRET: "smoke-auth-secret-not-a-real-credential-32",
      ENCRYPTION_KEY: "smoke-encryption-key-not-a-real-credential",
      SCREEN_PROXY_SECRET: "smoke-screen-proxy-secret-not-real-32x",
      SANDBOX_SUPERVISOR_TOKEN: "smoke-supervisor-token-not-a-real-credential",
      BETTER_AUTH_URL: origin,
      WEB_ORIGIN: origin,
      API_URL: origin,
      API_HOST: "127.0.0.1",
      API_PORT: String(apiPort),
      LOG_FORMAT: "json",
    };
    handles.push(startService(path.join(copyDir, "api.mjs"), serviceEnv, copyDir));
    handles.push(startService(path.join(copyDir, "worker.mjs"), serviceEnv, copyDir));
    // Ready means both services are up, as the desktop requires: the API's health answer
    // and the worker's ready line, which can follow the API by several seconds on first boot.
    let healthy = false;
    const workerReady = () => handles[1].text().includes('"message":"worker ready"');
    await waitFor(async () => {
      if (handles.some((handle) => handle.child.exitCode != null)) return "stop";
      if (!healthy) {
        try {
          const response = await fetch(`${origin}/rpc/health`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: {} }),
          });
          const body = response.ok ? await response.json() : null;
          healthy = body?.json?.ok === true && typeof body?.json?.version === "string";
        } catch {
          healthy = false;
        }
      }
      return healthy && workerReady();
    }, 90_000);
    if (!healthy || !workerReady()) {
      const logs = handles.map((handle) => redact(handle.text())).join("\n");
      throw new Error(
        `Service bundle smoke failed (health ${healthy}, worker ready ${workerReady()}).\n${logs}`,
      );
    }
    process.stdout.write("health ok\nworker ready\n");
  } finally {
    await Promise.all(handles.map((handle) => stopChild(handle)));
    if (postgres) await postgres.stop().catch(() => undefined);
    await rm(copyDir, { recursive: true, force: true });
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reason = smokeSkipReason();
  if (reason) {
    process.stdout.write(`${reason}\n`);
  } else {
    await runSmoke();
  }
}
