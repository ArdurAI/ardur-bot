import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSecretStorage } from "../host-service.js";
import type { NativePluginRegistry } from "./plugin-store.js";
import { NativePluginStore } from "./plugin-store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-store-fixture-"));
  roots.push(root);
  const key = randomBytes(32);
  const storage: HostSecretStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test-keyring",
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(value) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString();
    },
  };
  const rows: Awaited<ReturnType<NativePluginRegistry["installed"]>> = [];
  const registry = {
    files: vi.fn(async () => [{ path: "commands/review.md", bytes: Buffer.from("Review input.") }]),
    install: vi.fn(async (_preview: string, _directory: string, id: string) => {
      rows.push({ id, state: "installed" });
    }),
    uninstall: vi.fn(async (id: string) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
    }),
    installed: vi.fn(async () => rows),
  };
  let now = 0;
  const store = new NativePluginStore(root, storage, registry, () => now);
  return {
    root,
    store,
    storage,
    registry,
    rows,
    advance: () => {
      now += 16 * 60_000;
    },
  };
}
describe("native plugin recovery", () => {
  it("journals before registration and removes both files and owned components", async () => {
    const f = await fixture();
    f.registry.install.mockImplementationOnce(async (_preview, directory, id) => {
      expect(await readFile(path.join(directory, "commands/review.md"), "utf8")).toBe(
        "Review input.",
      );
      const bytes = Buffer.from(await readFile(path.join(f.root, "plugins.enc"), "utf8"), "base64");
      expect(bytes.toString()).not.toContain(id);
      expect(JSON.parse(f.storage.decryptString(bytes))).toMatchObject([
        { id, state: "installing" },
      ]);
      f.rows.push({ id, state: "installed" });
    });
    await f.store.install("preview");
    const id = f.rows[0]!.id;
    await f.store.recover();
    expect(f.registry.uninstall).not.toHaveBeenCalled();
    await f.store.uninstall(id);
    expect(f.rows).toEqual([]);
    expect(await readdir(f.root)).toEqual(["plugins.enc"]);
  });
  it("immediately rolls back files and the journal when the remote install never commits", async () => {
    const f = await fixture();
    f.registry.install.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(f.store.install("preview")).rejects.toThrow("Disconnected");
    expect(await readdir(f.root)).toEqual(["plugins.enc"]);
    const journal = Buffer.from(await readFile(path.join(f.root, "plugins.enc"), "utf8"), "base64");
    expect(JSON.parse(f.storage.decryptString(journal))).toEqual([]);
    expect(f.registry.uninstall).not.toHaveBeenCalled();
    await f.store.recover();
    expect(await readdir(f.root)).toEqual(["plugins.enc"]);
  });
  it("retains an in-flight install after a crash until its request expires", async () => {
    const f = await fixture();
    const id = randomUUID();
    await mkdir(path.join(f.root, id));
    await writeFile(
      path.join(f.root, "plugins.enc"),
      f.storage
        .encryptString(JSON.stringify([{ id, state: "installing", createdAt: 0 }]))
        .toString("base64"),
    );
    await f.store.recover();
    expect(await readdir(f.root)).toHaveLength(2);
    f.advance();
    await f.store.recover();
    expect(await readdir(f.root)).toEqual(["plugins.enc"]);
  });
  it.each(["lookup", "uninstall"])(
    "cleans local files even when remote rollback fails at %s",
    async (failure) => {
      const f = await fixture();
      f.registry.install.mockImplementationOnce(async (_preview, _directory, id) => {
        f.rows.push({ id, state: "installed" });
        throw new Error("Install disconnected");
      });
      if (failure === "lookup")
        f.registry.installed.mockRejectedValueOnce(new Error("Lookup disconnected"));
      else f.registry.uninstall.mockRejectedValueOnce(new Error("Uninstall disconnected"));
      await expect(f.store.install("preview")).rejects.toThrow("disconnected");
      expect(await readdir(f.root)).toEqual(["plugins.enc"]);
      const journal = Buffer.from(
        await readFile(path.join(f.root, "plugins.enc"), "utf8"),
        "base64",
      );
      expect(JSON.parse(f.storage.decryptString(journal))).toMatchObject([
        { id: f.rows[0]!.id, state: "removing" },
      ]);
      await f.store.recover();
      expect(f.rows).toEqual([]);
    },
  );
  it("removes partial extraction after a rejected bundle without attempting remote uninstall", async () => {
    const f = await fixture();
    f.registry.files.mockResolvedValueOnce([{ path: "../escape", bytes: Buffer.from("invalid") }]);
    await expect(f.store.install("preview")).rejects.toThrow("unsafe");
    expect(f.registry.install).not.toHaveBeenCalled();
    expect(f.registry.uninstall).not.toHaveBeenCalled();
    const journal = Buffer.from(await readFile(path.join(f.root, "plugins.enc"), "utf8"), "base64");
    expect(JSON.parse(f.storage.decryptString(journal))).toEqual([]);
  });
  it("retries interrupted removal and refuses unreadable recovery records", async () => {
    const f = await fixture();
    await f.store.install("preview");
    f.registry.uninstall.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(f.store.uninstall(f.rows[0]!.id)).rejects.toThrow("Disconnected");
    await f.store.recover();
    expect(f.rows).toEqual([]);
    await writeFile(path.join(f.root, "plugins.enc"), "x".repeat(256_001));
    await expect(f.store.recover()).rejects.toThrow("could not be read");
    expect((await readFile(path.join(f.root, "plugins.enc"), "utf8")).length).toBe(256_001);
  });
});
