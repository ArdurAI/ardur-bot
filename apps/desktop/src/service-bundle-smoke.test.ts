import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { smokeSkipReason } from "../scripts/service-bundle-smoke.mjs";

const script = fileURLToPath(new URL("../scripts/service-bundle-smoke.mjs", import.meta.url));

describe("service bundle smoke", () => {
  it("skips with a stated reason when no Postgres service is configured", () => {
    expect(smokeSkipReason({})).toMatch(/No Postgres service is configured/);
    expect(smokeSkipReason({ ARDURBOT_SMOKE_DATABASE_URL: "postgres://fixture" })).toBeNull();
    expect(smokeSkipReason({ ARDURBOT_SMOKE_EMBEDDED: "1" })).toBeNull();
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/No Postgres service is configured/);
  });

  it("starts bundled services with a secrets file and without secrets in the environment", async () => {
    const source = readFileSync(script, "utf8");
    const run = source.slice(source.indexOf("async function runSmoke"));
    expect(source).toContain("ARDURBOT_SECRETS_FILE");
    expect(run).toContain("bundledServiceEnvironment(");
    expect(run).not.toContain('BETTER_AUTH_SECRET: "');

    const { bundledServiceEnvironment, bundledSecretsText } = await import(
      "../scripts/service-bundle-smoke.mjs"
    );
    const databaseUrl = "postgres://ardurbot_app:fake-smoke-password@127.0.0.1:23456/ardurbot";
    const secrets = {
      APP_DATABASE_PASSWORD: "fake-smoke-password",
      BETTER_AUTH_SECRET: `fake-auth-marker-${"a".repeat(16)}`,
      ENCRYPTION_KEY: `fake-encryption-marker-${"b".repeat(12)}`,
      SCREEN_PROXY_SECRET: `fake-screen-marker-${"c".repeat(16)}`,
      SANDBOX_SUPERVISOR_TOKEN: `fake-supervisor-marker-${"d".repeat(12)}`,
    };
    const text = bundledSecretsText(secrets);
    expect(text).toContain("APP_DATABASE_PASSWORD=fake-smoke-password");
    expect(text).not.toContain("POSTGRES_PASSWORD");
    const env = bundledServiceEnvironment({
      parent: {
        PATH: "/usr/bin",
        NODE_ENV: "development",
        BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET,
        POSTGRES_PASSWORD: "fake-superuser-marker",
        REALTIME_DATABASE_URL: "postgres://app:fake-realtime-marker@127.0.0.1:23457/ardurbot",
        DATABASE_URL: databaseUrl,
      },
      databaseUrl,
      secretsFile: "/tmp/fixture-secrets.env",
      dataDir: "/tmp/fixture-data",
      origin: "http://127.0.0.1:3100",
      apiPort: 3100,
      nodePath: "/tmp/fixture-modules",
    });
    expect(env.ARDURBOT_SECRETS_FILE).toBe("/tmp/fixture-secrets.env");
    expect(env.DATABASE_URL).toBe("postgres://ardurbot_app@127.0.0.1:23456/ardurbot");
    expect(env.NODE_ENV).toBe("production");
    expect(env.SANDBOX_PROVIDER).toBe("desktop");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NODE_PATH).toBe("/tmp/fixture-modules");
    expect(env.API_PORT).toBe("3100");
    for (const key of [
      "BETTER_AUTH_SECRET",
      "ENCRYPTION_KEY",
      "SCREEN_PROXY_SECRET",
      "SANDBOX_SUPERVISOR_TOKEN",
      "APP_DATABASE_PASSWORD",
      "POSTGRES_PASSWORD",
      "REALTIME_DATABASE_URL",
    ])
      expect(env[key]).toBeUndefined();
    const encoded = JSON.stringify(env);
    for (const marker of [
      "fake-smoke-password",
      "fake-auth-marker",
      "fake-encryption-marker",
      "fake-screen-marker",
      "fake-supervisor-marker",
      "fake-superuser-marker",
      "fake-realtime-marker",
    ])
      expect(encoded).not.toContain(marker);
  });
});
