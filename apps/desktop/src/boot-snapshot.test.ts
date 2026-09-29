import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOT_SNAPSHOT_FILE,
  BootSnapshotStore,
  bootSnapshotFrom,
  DEFAULT_BOOT_SNAPSHOT,
} from "./boot-snapshot.js";

let userData: string;
const file = () => path.join(userData, BOOT_SNAPSHOT_FILE);

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "ardurbot-boot-"));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("boot snapshot validation", () => {
  it("accepts the three themes", () => {
    for (const theme of ["system", "light", "dark"] as const)
      expect(bootSnapshotFrom({ theme })).toEqual({ theme });
  });

  it.each([null, "light", ["light"], {}, { theme: "sepia" }, { theme: "" }, { theme: 7 }])(
    "rejects %j",
    (value) => {
      expect(bootSnapshotFrom(value)).toBeNull();
    },
  );

  it("keeps only the theme and drops other keys", () => {
    expect(
      bootSnapshotFrom({ theme: "light", language: "de", token: "session-secret", userId: "u1" }),
    ).toEqual({ theme: "light" });
  });
});

describe("boot snapshot store", () => {
  it("follows the system theme when nothing is saved", async () => {
    const store = new BootSnapshotStore(userData);
    expect(store.current).toEqual(DEFAULT_BOOT_SNAPSHOT);
    await expect(store.load()).resolves.toEqual({ theme: "system" });
  });

  it("keeps the saved theme across launches", async () => {
    await expect(new BootSnapshotStore(userData).save({ theme: "light" })).resolves.toBe(true);
    const next = new BootSnapshotStore(userData);
    await expect(next.load()).resolves.toEqual({ theme: "light" });
    expect(next.current).toEqual({ theme: "light" });
  });

  it("writes nothing but the theme", async () => {
    const store = new BootSnapshotStore(userData);
    await store.save({ theme: "dark", language: "pt-BR", token: "session-secret" });
    const saved = await readFile(file(), "utf8");
    expect(JSON.parse(saved)).toEqual({ theme: "dark" });
    expect(saved).not.toContain("session-secret");
    expect(saved).not.toContain("pt-BR");
  });

  it("ignores an invalid snapshot and keeps the current one", async () => {
    const store = new BootSnapshotStore(userData);
    await store.save({ theme: "light" });
    await expect(store.save({ theme: "sepia" })).resolves.toBe(false);
    expect(store.current).toEqual({ theme: "light" });
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ theme: "light" });
  });

  it("writes only when a value changes", async () => {
    const store = new BootSnapshotStore(userData);
    await expect(store.save({ theme: "system" })).resolves.toBe(false);
    await expect(stat(file())).rejects.toThrow();

    await expect(store.save({ theme: "dark" })).resolves.toBe(true);
    await rm(file());
    await expect(store.save({ theme: "dark" })).resolves.toBe(false);
    await expect(stat(file())).rejects.toThrow();
    await expect(store.save({ theme: "light" })).resolves.toBe(true);
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ theme: "light" });
  });

  it("saves the same values again after a write failed", async () => {
    // A file where the folder should be makes the write fail.
    const blocked = path.join(userData, "profile");
    await writeFile(blocked, "", "utf8");
    const store = new BootSnapshotStore(blocked);
    await expect(store.save({ theme: "light" })).rejects.toThrow();
    expect(store.current).toEqual(DEFAULT_BOOT_SNAPSHOT);

    await rm(blocked);
    await expect(store.save({ theme: "light" })).resolves.toBe(true);
    await expect(new BootSnapshotStore(blocked).load()).resolves.toEqual({
      theme: "light",
    });
  });

  it("keeps the last loaded or written snapshot when two queued saves fail", async () => {
    const blocked = path.join(userData, "profile");
    await writeFile(blocked, "", "utf8");
    const store = new BootSnapshotStore(blocked);
    const p1 = store.save({ theme: "light" });
    const p2 = store.save({ theme: "dark" });
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
    expect(store.current).toEqual(DEFAULT_BOOT_SNAPSHOT);
  });

  it("restores the written snapshot when two queued saves fail after a successful save", async () => {
    const store = new BootSnapshotStore(userData);
    await store.save({ theme: "light" });
    expect(store.current).toEqual({ theme: "light" });

    // Block writes by replacing the file with a directory so writes fail on the existing store.
    await rm(file());
    await mkdir(file());
    const p1 = store.save({ theme: "dark" });
    const p2 = store.save({ theme: "system" });
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
    expect(store.current).toEqual({ theme: "light" });

    await rm(file(), { recursive: true });
    await expect(store.save({ theme: "dark" })).resolves.toBe(true);
    expect(store.current).toEqual({ theme: "dark" });
  });

  it("keeps the last of several quick changes", async () => {
    const store = new BootSnapshotStore(userData);
    await Promise.all([
      store.save({ theme: "light" }),
      store.save({ theme: "system" }),
      store.save({ theme: "dark" }),
    ]);
    await expect(new BootSnapshotStore(userData).load()).resolves.toEqual({
      theme: "dark",
    });
  });

  it.each([
    ["not JSON", "{"],
    ["a list", '["light"]'],
    ["an unknown theme", '{"theme":"sepia"}'],
    ["an oversized file", JSON.stringify({ theme: "light", pad: "x".repeat(2048) })],
  ])("falls back to the defaults for %s", async (_label, contents) => {
    await writeFile(file(), contents, "utf8");
    await expect(new BootSnapshotStore(userData).load()).resolves.toEqual(DEFAULT_BOOT_SNAPSHOT);
  });

  it("drops unknown keys from a saved file", async () => {
    await writeFile(file(), '{"theme":"light","language":"de","token":"session-secret"}', "utf8");
    await expect(new BootSnapshotStore(userData).load()).resolves.toEqual({
      theme: "light",
    });
  });

  it.runIf(process.platform !== "win32")("keeps the file private to its owner", async () => {
    await new BootSnapshotStore(userData).save({ theme: "light" });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });
});
