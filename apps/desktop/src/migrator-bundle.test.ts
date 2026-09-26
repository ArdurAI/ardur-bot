import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { bundleMigrator } from "../scripts/bundle-services.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("bundles the SQL migrator for the main process with only pg left to install", async () => {
  // Inside the desktop package, where the packaged app resolves pg from.
  const build = path.join(import.meta.dirname, "..", "build");
  await mkdir(build, { recursive: true });
  const dir = await mkdtemp(path.join(build, "migrator-"));
  directories.push(dir);
  const { outfile, externals } = await bundleMigrator(path.join(dir, "db-migrate.js"));
  expect(externals).toEqual(["pg"]);
  const migrator = (await import(outfile)) as Record<string, unknown>;
  expect(typeof migrator.applySqlMigrationsToDatabase).toBe("function");
  expect(typeof migrator.ensureApplicationDatabase).toBe("function");
});
