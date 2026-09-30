import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const AUTH = `fake-auth-marker-${"a".repeat(16)}`;
const KEY = `fake-encryption-marker-${"b".repeat(12)}`;
const SCREEN = `fake-screen-marker-${"c".repeat(16)}`;
const SUPERVISOR = `fake-supervisor-marker-${"d".repeat(12)}`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const repoRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

function childSource(): string {
  const file = (relative: string) => JSON.stringify(path.join(repoRoot, relative));
  return `
import { FleetCatalog } from ${file("packages/adapters/src/fleet/catalog.ts")};
import { localFleetService } from ${file("packages/adapters/src/fleet/service.ts")};
import { createHostClient } from ${file("packages/adapters/src/remote-host-sandbox.ts")};

const expected = {
  auth: ${JSON.stringify(AUTH)},
  encryptionKey: ${JSON.stringify(KEY)},
  screen: ${JSON.stringify(SCREEN)},
  supervisor: ${JSON.stringify(SUPERVISOR)},
};
const failures = [];
function fail(name, error) {
  const message = error instanceof Error ? error.message : "failed";
  failures.push(name + ": " + message.split("\\n")[0]);
}
const fallback = {
  describe() {
    return {
      id: "desktop",
      kind: "desktop",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: {},
    };
  },
};
function catalog(options) {
  return new FleetCatalog({}, { load: () => "" }, options, fallback);
}
function supervisorToken(value) {
  const token = value?.docker?.supervisorToken;
  if (token !== expected.supervisor) {
    throw new Error("FleetCatalog did not use the secrets file supervisor token");
  }
}

if (process.env.NODE_ENV !== "production") failures.push("env: NODE_ENV");
if (process.env.VITEST !== undefined) failures.push("env: VITEST");
if (process.env.ARDURBOT_ALLOW_DEV_SECRETS !== undefined) failures.push("env: dev allowance");
for (const key of [
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "SCREEN_PROXY_SECRET",
  "SANDBOX_SUPERVISOR_TOKEN",
  "APP_DATABASE_PASSWORD",
  "POSTGRES_PASSWORD",
]) {
  if (process.env[key] !== undefined) failures.push("env: " + key + " is set");
}

try {
  // Desktop createApp passes AppEnv.sandboxSupervisorToken, which loadEnv leaves
  // unset unless the provider is docker.
  supervisorToken(
    catalog({
      supervisorUrl: "http://127.0.0.1:7091",
      supervisorToken: undefined,
    }),
  );
} catch (error) {
  fail("api", error);
}

try {
  const client = createHostClient();
  if (client?.options?.encryptionKey !== expected.encryptionKey) {
    throw new Error("host client did not use the secrets file encryption key");
  }
} catch (error) {
  fail("host", error);
}

try {
  const fleet = localFleetService();
  if (fleet?.secrets?.encryptionKey !== expected.encryptionKey) {
    throw new Error("local fleet service did not use the secrets file encryption key");
  }
} catch (error) {
  fail("fleet", error);
}

try {
  const { secretEnvironment } = await import(${file("packages/core/src/node/service-secrets.ts")});
  const {
    resolveAuthSecret,
    resolveEncryptionKey,
    resolveScreenProxySecret,
    resolveSupervisorToken,
  } = await import(${file("packages/core/src/secrets-guard.ts")});
  const source = secretEnvironment();
  if (
    source.VITEST !== undefined ||
    source.NODE_ENV !== "production" ||
    source.ARDURBOT_ALLOW_DEV_SECRETS !== undefined
  ) {
    throw new Error("secret environment is not a production environment");
  }
  if (resolveAuthSecret(source) !== expected.auth) throw new Error("auth resolver");
  if (resolveEncryptionKey(source) !== expected.encryptionKey) throw new Error("encryption resolver");
  if (resolveScreenProxySecret(source) !== expected.screen) throw new Error("screen resolver");
  if (resolveSupervisorToken(source) !== expected.supervisor) throw new Error("supervisor resolver");
  supervisorToken(
    catalog({
      supervisorUrl: source.SANDBOX_SUPERVISOR_URL,
      supervisorToken: source.SANDBOX_SUPERVISOR_TOKEN,
    }),
  );
  let threw = false;
  try {
    resolveEncryptionKey(process.env);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("process.env resolved the encryption key");
} catch (error) {
  fail("resolvers", error);
}

if (failures.length) {
  console.error(failures.join("\\n"));
  process.exit(1);
}
console.log("ok");
`;
}

it("builds the API and worker secret clients from the secrets file in production", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "local-secrets-"));
  roots.push(root);
  const secrets = path.join(root, "secrets.env");
  await writeFile(
    secrets,
    [
      "APP_DATABASE_PASSWORD=fake-role-marker",
      `BETTER_AUTH_SECRET=${AUTH}`,
      `ENCRYPTION_KEY=${KEY}`,
      `SCREEN_PROXY_SECRET=${SCREEN}`,
      `SANDBOX_SUPERVISOR_TOKEN=${SUPERVISOR}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const script = path.join(root, "check.ts");
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(script, childSource(), { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), script],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        TMPDIR: root,
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "desktop",
        ARDURBOT_SECRETS_FILE: secrets,
        DATABASE_URL: "postgres://ardurbot_app@127.0.0.1:23456/ardurbot",
      },
    },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
}, 150_000);
