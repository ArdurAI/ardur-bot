import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "./contract.js";
import { SystemStore } from "./store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "system-store-"));
  directories.push(directory);
  return {
    directory,
    file: path.join(directory, "system-settings.json"),
    store: new SystemStore(directory),
  };
}
it("persists machine preferences in an owner-only atomic local file", async () => {
  const f = await fixture();
  expect(await f.store.read()).toEqual(DEFAULT_PREFERENCES);
  await f.store.write({ ...DEFAULT_PREFERENCES, menuBar: true, quickAccess: "Alt+Space" });
  expect(await new SystemStore(f.directory).read()).toMatchObject({
    menuBar: true,
    quickAccess: "Alt+Space",
  });
  if (process.platform !== "win32") expect((await stat(f.file)).mode & 0o777).toBe(0o600);
});
it("ignores corrupt, oversized, unknown and invalid preferences", async () => {
  const f = await fixture();
  for (const value of [
    "{",
    " ".repeat(4097),
    JSON.stringify({
      __proto__: { keepAwake: true },
      keepAwake: "yes",
      quickAccess: "CapsLock",
      dispatch: true,
    }),
  ]) {
    await writeFile(f.file, value);
    expect(await f.store.read()).toEqual(DEFAULT_PREFERENCES);
  }
});
it("does not read or overwrite a symlink target", async () => {
  const f = await fixture();
  const other = path.join(f.directory, "other");
  await writeFile(other, '{"keepAwake":true}');
  await symlink(other, f.file);
  expect(await f.store.read()).toEqual(DEFAULT_PREFERENCES);
  await f.store.write(DEFAULT_PREFERENCES);
  expect(await readFile(other, "utf8")).toBe('{"keepAwake":true}');
});
