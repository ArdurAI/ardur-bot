// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Bundle fixtures contain literal protocol placeholders.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSecretStorage } from "../host-service.js";
import { ExtensionStore } from "./store.js";

const roots: string[] = [];
function storageFixture(): HostSecretStorage {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test-keyring",
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(value) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}
const fixture = {
  manifest_version: "0.3",
  name: "fixture",
  version: "1.0.0",
  description: "Fixture server",
  author: { name: "Fixture publisher" },
  server: {
    type: "node",
    entry_point: "server.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server.js"],
      env: { TOKEN: "${user_config.token}" },
    },
  },
  user_config: {
    token: {
      type: "string",
      title: "Token",
      description: "Authentication",
      sensitive: true,
      required: true,
      default: "fixture-default-secret",
    },
  },
};
const files = () => [
  { path: "manifest.json", bytes: Buffer.from(JSON.stringify(fixture)) },
  { path: "server.js", bytes: Buffer.from("fixture") },
];
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "extension-store-fixture-"));
  roots.push(root);
  const storage = storageFixture();
  const registry = { upsert: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  const store = new ExtensionStore(root, storage, registry, {}, "linux");
  return { root, storage, registry, store };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("encrypted extension install lifecycle", () => {
  it("reviews without registering, installs, restores, configures and uninstalls", async () => {
    const { root, storage, registry, store } = await setup();
    const preview = store.prepare(files());
    expect(registry.upsert).not.toHaveBeenCalled();
    expect(JSON.stringify(preview)).not.toContain("fixture-default-secret");
    const installed = await store.install(preview.id, { token: "fixture-private-value" });
    expect(registry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: installed.id,
        launch: expect.objectContaining({ env: { TOKEN: "fixture-private-value" } }),
      }),
    );
    expect(await readdir(path.join(root, installed.id))).toEqual(["manifest.json", "server.js"]);
    const manifest = await readFile(path.join(root, installed.id, "manifest.json"), "utf8");
    expect(manifest).not.toContain("fixture-default-secret");
    expect(manifest).not.toContain("fixture-private-value");
    const persisted = await readFile(path.join(root, "extensions.enc"), "utf8");
    expect(persisted).not.toContain("fixture-private-value");
    expect(Buffer.from(persisted, "base64").toString()).not.toContain("fixture-private-value");
    const restarted = new ExtensionStore(root, storage, registry, {}, "linux");
    expect(await restarted.list()).toEqual([installed]);
    await restarted.recover();
    await restarted.configure(installed.id, { token: "fixture-replacement" });
    expect(JSON.stringify(await restarted.list())).not.toContain("fixture-replacement");
    await expect(store.install(preview.id, {})).rejects.toThrow("Choose the bundle again");
    await restarted.uninstall(installed.id);
    expect(registry.remove).toHaveBeenCalledWith(installed.id);
    expect(await restarted.list()).toEqual([]);
    expect(await readdir(root)).toEqual(["extensions.enc"]);
  });
  it("refuses plaintext storage and duplicate installs", async () => {
    const { root, storage, registry, store } = await setup();
    storage.getSelectedStorageBackend = () => "basic_text";
    expect(() => new ExtensionStore(root, storage, registry, {}, "linux").prepare(files())).toThrow(
      "Unlock secure storage",
    );
    storage.getSelectedStorageBackend = () => "test-keyring";
    await store.install(store.prepare(files()).id, {});
    await expect(store.install(store.prepare(files()).id, {})).rejects.toThrow("already installed");
    expect(registry.upsert).toHaveBeenCalledTimes(1);
  });
  it("rolls back failed registration and retains retryable removal if cleanup fails", async () => {
    const { root, registry, store } = await setup();
    registry.upsert.mockRejectedValueOnce(new Error("Fixture registration failed"));
    await expect(store.install(store.prepare(files()).id, {})).rejects.toThrow(
      "registration failed",
    );
    expect(await store.list()).toEqual([]);
    expect(await readdir(root)).toEqual(["extensions.enc"]);
    const entry = await store.install(store.prepare(files()).id, {});
    registry.remove.mockRejectedValueOnce(new Error("Fixture disconnected"));
    await expect(store.uninstall(entry.id)).rejects.toThrow("disconnected");
    expect((await store.list())[0]?.state).toBe("removing");
    await store.recover();
    expect(await store.list()).toEqual([]);
    expect(await readdir(root)).toEqual(["extensions.enc"]);
  });
  it("rejects expired or cancelled consent and missing executable files", async () => {
    const { root, storage, registry } = await setup();
    let now = 0;
    const store = new ExtensionStore(root, storage, registry, {}, "linux", () => now);
    const preview = store.prepare(files());
    now = 16 * 60_000;
    await expect(store.install(preview.id, {})).rejects.toThrow("review");
    const next = store.prepare(files());
    store.cancel(next.id);
    await expect(store.install(next.id, {})).rejects.toThrow("review");
    expect(() => store.prepare(files().slice(0, 1))).toThrow("entry point");
    expect(registry.upsert).not.toHaveBeenCalled();
  });
});
