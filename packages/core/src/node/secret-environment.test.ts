import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveAuthSecret,
  resolveEncryptionKey,
  resolveScreenProxySecret,
  resolveSupervisorToken,
} from "@ardurbot/core";
import { afterEach, describe, expect, it } from "vitest";
import { resetServiceSecretsMemo, secretEnvironment } from "./service-secrets.js";

const AUTH = `fake-auth-marker-${"a".repeat(16)}`;
const KEY = `fake-encryption-marker-${"b".repeat(12)}`;
const SCREEN = `fake-screen-marker-${"c".repeat(16)}`;
const SUPERVISOR = `fake-supervisor-marker-${"d".repeat(12)}`;

const roots: string[] = [];
afterEach(async () => {
  resetServiceSecretsMemo();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("secretEnvironment", () => {
  it("is the process environment when no secrets file is set", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "development", PATH: "/usr/bin" };
    expect(secretEnvironment(env)).toBe(env);
  });

  it("resolves production secrets from the file alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-environment-"));
    roots.push(root);
    const file = path.join(root, "secrets.env");
    await writeFile(
      file,
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
    const explicit: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      SANDBOX_PROVIDER: "desktop",
      ARDURBOT_SECRETS_FILE: file,
      DATABASE_URL: "postgres://ardurbot_app@127.0.0.1:23456/ardurbot",
    };
    expect(explicit.VITEST).toBeUndefined();
    expect(explicit.ARDURBOT_ALLOW_DEV_SECRETS).toBeUndefined();
    expect(explicit.NODE_ENV).toBe("production");
    expect(() => resolveAuthSecret(explicit)).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => resolveEncryptionKey(explicit)).toThrow(/ENCRYPTION_KEY/);
    expect(() => resolveScreenProxySecret(explicit)).toThrow(/SCREEN_PROXY_SECRET/);
    expect(() => resolveSupervisorToken(explicit)).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);

    const source = secretEnvironment(explicit);
    expect(source).not.toBe(explicit);
    expect(source.VITEST).toBeUndefined();
    expect(source.ARDURBOT_ALLOW_DEV_SECRETS).toBeUndefined();
    expect(source.NODE_ENV).toBe("production");
    expect(resolveAuthSecret(source)).toBe(AUTH);
    expect(resolveEncryptionKey(source)).toBe(KEY);
    expect(resolveScreenProxySecret(source)).toBe(SCREEN);
    expect(resolveSupervisorToken(source)).toBe(SUPERVISOR);
    expect(explicit.ENCRYPTION_KEY).toBeUndefined();
    expect(explicit.BETTER_AUTH_SECRET).toBeUndefined();
    expect(explicit.SCREEN_PROXY_SECRET).toBeUndefined();
    expect(explicit.SANDBOX_SUPERVISOR_TOKEN).toBeUndefined();
    expect(explicit.APP_DATABASE_PASSWORD).toBeUndefined();
    expect(new URL(explicit.DATABASE_URL!).password).toBe("");
    expect(new URL(source.DATABASE_URL!).password).toBe("fake-role-marker");
  });

  it("resolves database URLs from the secrets file alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-environment-db-"));
    roots.push(root);
    const file = path.join(root, "secrets.env");
    await writeFile(
      file,
      [
        "DATABASE_URL=postgres://file_user:file_pass@127.0.0.1:5433/file_db",
        "REALTIME_DATABASE_URL=postgres://rt_user:rt_pass@127.0.0.1:5433/rt_db",
      ].join("\n"),
      { mode: 0o600 },
    );
    const explicit: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      ARDURBOT_SECRETS_FILE: file,
      DATABASE_URL: "postgres://env_user@127.0.0.1:5433/env_db",
      REALTIME_DATABASE_URL: "postgres://rt_env@127.0.0.1:5433/rt_env_db",
    };
    const source = secretEnvironment(explicit);
    expect(source.DATABASE_URL).toBe("postgres://file_user:file_pass@127.0.0.1:5433/file_db");
    expect(source.REALTIME_DATABASE_URL).toBe("postgres://rt_user:rt_pass@127.0.0.1:5433/rt_db");
    expect(explicit.DATABASE_URL).toBe("postgres://env_user@127.0.0.1:5433/env_db");
    expect(explicit.REALTIME_DATABASE_URL).toBe("postgres://rt_env@127.0.0.1:5433/rt_env_db");
  });
});
