import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadRootEnv } from "./load-root-env.js";

const KEYS = ["ARDURBOT_TEST_MARKER", "DATA_DIR", "ARDURBOT_ENV_FILE"] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
const cleanup: string[] = [];

afterEach(async () => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
    delete saved[key];
  }
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function clearEnv() {
  for (const key of KEYS) {
    if (!(key in saved)) saved[key] = process.env[key];
    delete process.env[key];
  }
}

it("records the env file it loaded for the host command guardrail", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "root-env-")));
  cleanup.push(root);
  await mkdir(path.join(root, "nested", "deeper"), { recursive: true });
  await writeFile(path.join(root, ".env"), "ARDURBOT_TEST_MARKER=fixture\nDATA_DIR=./data\n");
  clearEnv();
  const cwd = process.cwd();
  process.chdir(path.join(root, "nested", "deeper"));
  try {
    loadRootEnv();
  } finally {
    process.chdir(cwd);
  }
  expect(process.env.ARDURBOT_TEST_MARKER).toBe("fixture");
  expect(process.env.ARDURBOT_ENV_FILE).toBe(path.join(root, ".env"));
  expect(process.env.DATA_DIR).toBe(path.join(root, "data"));
});

it("does not copy control-plane secrets from the env file when a secrets file is configured", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "root-env-secrets-")));
  cleanup.push(root);
  await mkdir(path.join(root, "nested"), { recursive: true });
  await writeFile(
    path.join(root, ".env"),
    [
      "ARDURBOT_TEST_MARKER=fixture",
      "DATA_DIR=./data",
      "ENCRYPTION_KEY=fake-encryption-marker",
      "DATABASE_URL=postgres://app:fake-url-marker@127.0.0.1:9/db",
      "REALTIME_DATABASE_URL=postgres://app:fake-url-marker@127.0.0.1:9/rt",
      "POSTGRES_PASSWORD=fake-superuser-marker",
      "APP_DATABASE_PASSWORD=fake-role-marker",
      "BETTER_AUTH_SECRET=fake-auth-marker",
      "SCREEN_PROXY_SECRET=fake-screen-marker",
      "SANDBOX_SUPERVISOR_TOKEN=fake-supervisor-marker",
    ].join("\n"),
  );
  clearEnv();
  const held = [
    "ENCRYPTION_KEY",
    "DATABASE_URL",
    "REALTIME_DATABASE_URL",
    "POSTGRES_PASSWORD",
    "APP_DATABASE_PASSWORD",
    "BETTER_AUTH_SECRET",
    "SCREEN_PROXY_SECRET",
    "SANDBOX_SUPERVISOR_TOKEN",
    "ARDURBOT_SECRETS_FILE",
  ] as const;
  const previous: Partial<Record<(typeof held)[number], string | undefined>> = {};
  for (const key of held) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ARDURBOT_SECRETS_FILE = path.join(root, "secrets.env");
  const cwd = process.cwd();
  process.chdir(path.join(root, "nested"));
  try {
    loadRootEnv();
    expect(process.env.ARDURBOT_TEST_MARKER).toBe("fixture");
    expect(process.env.DATA_DIR).toBe(path.join(root, "data"));
    expect(process.env.ARDURBOT_ENV_FILE).toBe(path.join(root, ".env"));
    for (const key of held) {
      if (key === "ARDURBOT_SECRETS_FILE") continue;
      expect(process.env[key]).toBeUndefined();
    }
  } finally {
    process.chdir(cwd);
    for (const key of held) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

it("still loads a dev env file's keys when no secrets file is configured", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "root-env-dev-")));
  cleanup.push(root);
  await writeFile(path.join(root, ".env"), "ENCRYPTION_KEY=fake-encryption-marker\n");
  clearEnv();
  const previousKey = process.env.ENCRYPTION_KEY;
  const previousFile = process.env.ARDURBOT_SECRETS_FILE;
  delete process.env.ENCRYPTION_KEY;
  delete process.env.ARDURBOT_SECRETS_FILE;
  const cwd = process.cwd();
  process.chdir(root);
  try {
    loadRootEnv();
    expect(process.env.ENCRYPTION_KEY).toBe("fake-encryption-marker");
  } finally {
    process.chdir(cwd);
    if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousKey;
    if (previousFile === undefined) delete process.env.ARDURBOT_SECRETS_FILE;
    else process.env.ARDURBOT_SECRETS_FILE = previousFile;
  }
});

it("leaves the marker unset when no env file exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "root-env-empty-"));
  cleanup.push(root);
  clearEnv();
  const cwd = process.cwd();
  process.chdir(root);
  try {
    loadRootEnv();
  } finally {
    process.chdir(cwd);
  }
  expect(process.env.ARDURBOT_ENV_FILE).toBeUndefined();
});
