import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAppEnv } from "./app-env.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const AUTH = `fake-auth-marker-${"a".repeat(16)}`;
const KEY = `fake-encryption-marker-${"b".repeat(12)}`;
const SCREEN = `fake-screen-marker-${"c".repeat(16)}`;

describe("loadAppEnv", () => {
  it("reads a secrets file in production without copying it onto the environment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ardurbot-app-env-"));
    directories.push(root);
    const secretsFile = path.join(root, "secrets.env");
    await writeFile(
      secretsFile,
      [
        "APP_DATABASE_PASSWORD=fake-role-marker",
        `BETTER_AUTH_SECRET=${AUTH}`,
        `ENCRYPTION_KEY=${KEY}`,
        `SCREEN_PROXY_SECRET=${SCREEN}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await chmod(secretsFile, 0o600);
    const databaseUrl = "postgres://ardurbot_app@127.0.0.1:23456/ardurbot";
    const source: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      SANDBOX_PROVIDER: "desktop",
      ARDURBOT_SECRETS_FILE: secretsFile,
      DATABASE_URL: databaseUrl,
    };
    const beforeAuth = process.env.BETTER_AUTH_SECRET;
    const beforeKey = process.env.ENCRYPTION_KEY;
    const beforeScreen = process.env.SCREEN_PROXY_SECRET;
    const beforePassword = process.env.APP_DATABASE_PASSWORD;
    const env = loadAppEnv(source);
    expect(env.authSecret).toBe(AUTH);
    expect(env.encryptionKey).toBe(KEY);
    expect(env.screenProxySecret).toBe(SCREEN);
    expect(env.sandboxProvider).toBe("desktop");
    expect(env.sandboxSupervisorToken).toBeUndefined();
    expect(new URL(env.databaseUrl).password).toBe("fake-role-marker");
    expect(new URL(env.databaseUrl).username).toBe("ardurbot_app");
    expect(new URL(env.realtimeDatabaseUrl).password).toBe("fake-role-marker");
    expect(source.DATABASE_URL).toBe(databaseUrl);
    expect(new URL(source.DATABASE_URL).password).toBe("");
    expect(source.BETTER_AUTH_SECRET).toBeUndefined();
    expect(source.ENCRYPTION_KEY).toBeUndefined();
    expect(source.SCREEN_PROXY_SECRET).toBeUndefined();
    expect(source.APP_DATABASE_PASSWORD).toBeUndefined();
    expect(process.env.BETTER_AUTH_SECRET).toBe(beforeAuth);
    expect(process.env.ENCRYPTION_KEY).toBe(beforeKey);
    expect(process.env.SCREEN_PROXY_SECRET).toBe(beforeScreen);
    expect(process.env.APP_DATABASE_PASSWORD).toBe(beforePassword);
  });

  it("keeps development startup unchanged when no secrets file is set", () => {
    const source: NodeJS.ProcessEnv = {
      NODE_ENV: "development",
      DATABASE_URL: "postgres://ardurbot:ardurbot@127.0.0.1:5433/ardurbot",
    };
    const env = loadAppEnv(source);
    expect(env.databaseUrl).toBe(source.DATABASE_URL);
    expect(env.realtimeDatabaseUrl).toBe(source.DATABASE_URL);
    expect(env.nodeEnv).toBe("development");
    expect(source.BETTER_AUTH_SECRET).toBeUndefined();
  });

  it("resolves application config through the secrets overlay", () => {
    const app = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
    const entry = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(app).toContain("loadAppEnv()");
    expect(app).not.toContain("loadEnv(process.env)");
    expect(entry).toContain("loadAppEnv()");
    expect(entry).not.toContain("loadEnv(serviceProcessEnvironment");
  });
});
