import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadServiceSecrets,
  SERVICE_SECRET_KEYS,
  serviceProcessEnvironment,
} from "./service-secrets.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function secretsFile(lines: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "service-secrets-"));
  roots.push(root);
  const file = path.join(root, "secrets.env");
  await writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return file;
}

describe("loadServiceSecrets", () => {
  it("does nothing when ARDURBOT_SECRETS_FILE is unset", () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: "postgres://app@127.0.0.1:5433/db" };
    expect(loadServiceSecrets(env)).toEqual({});
    expect(env).toEqual({ DATABASE_URL: "postgres://app@127.0.0.1:5433/db" });
    expect(serviceProcessEnvironment(env)).toBe(env);
  });

  it("returns only the service keys, and never writes them onto the environment", async () => {
    const file = await secretsFile([
      "POSTGRES_PASSWORD=fake-superuser-marker",
      "APP_DATABASE_PASSWORD=fake-role-marker",
      "BETTER_AUTH_SECRET=fake-auth-marker",
      "ENCRYPTION_KEY=fake-encryption-marker",
      "SCREEN_PROXY_SECRET=fake-screen-marker",
      "SANDBOX_SUPERVISOR_TOKEN=fake-supervisor-marker",
    ]);
    const env: NodeJS.ProcessEnv = { ARDURBOT_SECRETS_FILE: file, PATH: "/usr/bin" };
    const overlay = loadServiceSecrets(env);
    for (const key of SERVICE_SECRET_KEYS) expect(overlay[key]).toMatch(/^fake-.*-marker$/);
    expect(overlay.POSTGRES_PASSWORD).toBeUndefined();
    expect(env).toEqual({ ARDURBOT_SECRETS_FILE: file, PATH: "/usr/bin" });
    const serviceEnv = serviceProcessEnvironment(env);
    expect(serviceEnv).not.toBe(env);
    expect(serviceEnv.ENCRYPTION_KEY).toBe("fake-encryption-marker");
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(serviceEnv.POSTGRES_PASSWORD).toBeUndefined();
  });

  it("keeps an explicit environment value over the file's, like loadRootEnv", async () => {
    const file = await secretsFile(["ENCRYPTION_KEY=fake-file-marker"]);
    const env: NodeJS.ProcessEnv = {
      ARDURBOT_SECRETS_FILE: file,
      ENCRYPTION_KEY: "fake-env-marker",
    };
    const overlay = loadServiceSecrets(env);
    expect(overlay.ENCRYPTION_KEY).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBe("fake-env-marker");
  });

  it("joins a passwordless DATABASE_URL on the overlay only", async () => {
    const file = await secretsFile(["APP_DATABASE_PASSWORD=fake-role-marker"]);
    const env: NodeJS.ProcessEnv = {
      ARDURBOT_SECRETS_FILE: file,
      DATABASE_URL: "postgres://ardurbot_app@127.0.0.1:23456/ardurbot",
    };
    const overlay = loadServiceSecrets(env);
    const url = new URL(overlay.DATABASE_URL!);
    expect(url.username).toBe("ardurbot_app");
    expect(url.password).toBe("fake-role-marker");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("23456");
    expect(url.pathname).toBe("/ardurbot");
    expect(new URL(env.DATABASE_URL!).password).toBe("");
    expect(env.APP_DATABASE_PASSWORD).toBeUndefined();
    const serviceEnv = serviceProcessEnvironment(env);
    expect(new URL(serviceEnv.DATABASE_URL!).password).toBe("fake-role-marker");
    expect(new URL(env.DATABASE_URL!).password).toBe("");
  });

  it("never rewrites a DATABASE_URL that already has a password or names no user", async () => {
    const file = await secretsFile(["APP_DATABASE_PASSWORD=fake-role-marker"]);
    for (const databaseUrl of [
      "postgres://ardurbot_app:already@127.0.0.1:23456/ardurbot",
      "postgres://127.0.0.1:23456/ardurbot",
      "http://127.0.0.1:3100",
      "not a url",
    ]) {
      const env: NodeJS.ProcessEnv = { ARDURBOT_SECRETS_FILE: file, DATABASE_URL: databaseUrl };
      const overlay = loadServiceSecrets(env);
      expect(overlay.DATABASE_URL).toBeUndefined();
      expect(env.DATABASE_URL).toBe(databaseUrl);
    }
  });

  it("fails closed on a relative path or an unreadable file", async () => {
    const relative: NodeJS.ProcessEnv = { ARDURBOT_SECRETS_FILE: "relative/secrets.env" };
    expect(() => loadServiceSecrets(relative)).toThrow(
      "ARDURBOT_SECRETS_FILE must be an absolute path.",
    );
    expect(relative).toEqual({ ARDURBOT_SECRETS_FILE: "relative/secrets.env" });
    const root = await mkdtemp(path.join(tmpdir(), "service-secrets-missing-"));
    roots.push(root);
    const missing: NodeJS.ProcessEnv = {
      ARDURBOT_SECRETS_FILE: path.join(root, "absent.env"),
    };
    expect(() => loadServiceSecrets(missing)).toThrow(
      "The service secrets file could not be read.",
    );
    expect(missing.ENCRYPTION_KEY).toBeUndefined();
  });
});
