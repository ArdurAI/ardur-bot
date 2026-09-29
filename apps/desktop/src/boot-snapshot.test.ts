import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  it("accepts the three themes and the web app's language tags", () => {
    for (const theme of ["system", "light", "dark"] as const)
      for (const language of ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru"])
        expect(bootSnapshotFrom({ theme, language })).toEqual({ theme, language });
    expect(bootSnapshotFrom({ theme: "dark", language: "zh-Hans-CN" })).toEqual({
      theme: "dark",
      language: "zh-Hans-CN",
    });
  });

  it.each([
    null,
    "light",
    ["light", "de"],
    {},
    { theme: "light" },
    { language: "de" },
    { theme: "sepia", language: "de" },
    { theme: "light", language: "" },
    { theme: "light", language: "EN" },
    { theme: "light", language: "de_DE" },
    { theme: "light", language: "de\nsecret" },
    { theme: "light", language: "a-very-long-value-that-is-not-a-language" },
    { theme: "light", language: 7 },
  ])("rejects %j", (value) => {
    expect(bootSnapshotFrom(value)).toBeNull();
  });

  it("keeps only the theme and the language", () => {
    expect(
      bootSnapshotFrom({ theme: "light", language: "de", token: "session-secret", userId: "u1" }),
    ).toEqual({ theme: "light", language: "de" });
  });
});

describe("boot snapshot store", () => {
  it("follows the system theme in English when nothing is saved", async () => {
    const store = new BootSnapshotStore(userData);
    expect(store.current).toEqual(DEFAULT_BOOT_SNAPSHOT);
    await expect(store.load()).resolves.toEqual({ theme: "system", language: "en" });
  });

  it("keeps the saved theme and language across launches", async () => {
    await expect(
      new BootSnapshotStore(userData).save({ theme: "light", language: "de" }),
    ).resolves.toBe(true);
    const next = new BootSnapshotStore(userData);
    await expect(next.load()).resolves.toEqual({ theme: "light", language: "de" });
    expect(next.current).toEqual({ theme: "light", language: "de" });
  });

  it("writes nothing but the theme and the language", async () => {
    const store = new BootSnapshotStore(userData);
    await store.save({ theme: "dark", language: "pt-BR", token: "session-secret" });
    const saved = await readFile(file(), "utf8");
    expect(JSON.parse(saved)).toEqual({ theme: "dark", language: "pt-BR" });
    expect(saved).not.toContain("session-secret");
  });

  it("ignores an invalid snapshot and keeps the current one", async () => {
    const store = new BootSnapshotStore(userData);
    await store.save({ theme: "light", language: "de" });
    await expect(store.save({ theme: "sepia", language: "ko" })).resolves.toBe(false);
    expect(store.current).toEqual({ theme: "light", language: "de" });
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ theme: "light", language: "de" });
  });

  it("writes only when a value changes", async () => {
    const store = new BootSnapshotStore(userData);
    await expect(store.save({ theme: "system", language: "en" })).resolves.toBe(false);
    await expect(stat(file())).rejects.toThrow();

    await expect(store.save({ theme: "dark", language: "en" })).resolves.toBe(true);
    await rm(file());
    await expect(store.save({ theme: "dark", language: "en" })).resolves.toBe(false);
    await expect(stat(file())).rejects.toThrow();
    await expect(store.save({ theme: "dark", language: "ko" })).resolves.toBe(true);
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ theme: "dark", language: "ko" });
  });

  it("saves the same values again after a write failed", async () => {
    // A file where the folder should be makes the write fail.
    const blocked = path.join(userData, "profile");
    await writeFile(blocked, "", "utf8");
    const store = new BootSnapshotStore(blocked);
    await expect(store.save({ theme: "light", language: "de" })).rejects.toThrow();
    expect(store.current).toEqual(DEFAULT_BOOT_SNAPSHOT);

    await rm(blocked);
    await expect(store.save({ theme: "light", language: "de" })).resolves.toBe(true);
    await expect(new BootSnapshotStore(blocked).load()).resolves.toEqual({
      theme: "light",
      language: "de",
    });
  });

  it("keeps the last of several quick changes", async () => {
    const store = new BootSnapshotStore(userData);
    await Promise.all([
      store.save({ theme: "light", language: "en" }),
      store.save({ theme: "dark", language: "en" }),
      store.save({ theme: "dark", language: "ru" }),
    ]);
    await expect(new BootSnapshotStore(userData).load()).resolves.toEqual({
      theme: "dark",
      language: "ru",
    });
  });

  it.each([
    ["not JSON", "{"],
    ["a list", '["light","de"]'],
    ["an unknown theme", '{"theme":"sepia","language":"de"}'],
    ["a missing language", '{"theme":"light"}'],
    [
      "an oversized file",
      JSON.stringify({ theme: "light", language: "de", pad: "x".repeat(2048) }),
    ],
  ])("falls back to the defaults for %s", async (_label, contents) => {
    await writeFile(file(), contents, "utf8");
    await expect(new BootSnapshotStore(userData).load()).resolves.toEqual(DEFAULT_BOOT_SNAPSHOT);
  });

  it("drops unknown keys from a saved file", async () => {
    await writeFile(file(), '{"theme":"light","language":"de","token":"session-secret"}', "utf8");
    await expect(new BootSnapshotStore(userData).load()).resolves.toEqual({
      theme: "light",
      language: "de",
    });
  });

  it.runIf(process.platform !== "win32")("keeps the file private to its owner", async () => {
    await new BootSnapshotStore(userData).save({ theme: "light", language: "de" });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });
});
