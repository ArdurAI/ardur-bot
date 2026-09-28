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
