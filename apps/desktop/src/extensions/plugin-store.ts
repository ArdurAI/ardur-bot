import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { HostSecretStorage } from "../host-service.js";
import { hostStorageAvailable } from "../host-service.js";
import { readPrivateFile, writePrivateFile } from "../setup-store.js";
import type { BundleFile } from "./files.js";
import { writeBundleFiles } from "./files.js";

type Installed = { id: string; createdAt: number; state: "installing" | "installed" | "removing" };
export interface NativePluginRegistry {
  files(previewId: string): Promise<BundleFile[]>;
  install(previewId: string, directory: string, id: string): Promise<void>;
  uninstall(id: string): Promise<void>;
  installed(): Promise<{ id: string; state: Installed["state"] }[]>;
}
export class NativePluginStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly storage: HostSecretStorage,
    private readonly registry: NativePluginRegistry,
    private readonly now = Date.now,
  ) {}
  private exclusive<T>(action: () => Promise<T>) {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async read(): Promise<Installed[]> {
    if (!hostStorageAvailable(this.storage))
      throw new Error("Unlock secure storage, then try again.");
    const filename = path.join(this.directory, "plugins.enc");
    const text = await readPrivateFile(filename, 256_000);
    if (text === null) {
      const missing = await lstat(filename).then(
        () => false,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return true;
          throw error;
        },
      );
      if (!missing) throw new Error("Plugin settings could not be read.");
      return [];
    }
    let rows: unknown;
    try {
      rows = JSON.parse(this.storage.decryptString(Buffer.from(text, "base64")));
    } catch {
      throw new Error("Plugin settings could not be read.");
    }
    if (
      !Array.isArray(rows) ||
      rows.length > 100 ||
      rows.some(
        (row) =>
          !row ||
          !/^[a-f0-9-]{36}$/.test(row.id) ||
          !["installing", "installed", "removing"].includes(row.state) ||
          !Number.isFinite(row.createdAt),
      )
    )
      throw new Error("Plugin settings could not be read.");
    return rows;
  }
  private async write(rows: Installed[]) {
    if (!hostStorageAvailable(this.storage))
      throw new Error("Unlock secure storage, then try again.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writePrivateFile(
      path.join(this.directory, "plugins.enc"),
      this.storage.encryptString(JSON.stringify(rows)).toString("base64"),
    );
  }
  install(previewId: string) {
    return this.exclusive(async () => {
      const rows = await this.read();
      if (rows.length >= 100) throw new Error("Remove a plugin before adding another.");
      const files = await this.registry.files(previewId);
      const entry: Installed = { id: randomUUID(), createdAt: this.now(), state: "installing" };
      await this.write([...rows, entry]);
      try {
        await writeBundleFiles(path.join(this.directory, entry.id), files);
        await this.registry.install(previewId, path.join(this.directory, entry.id), entry.id);
        entry.state = "installed";
        await this.write([...rows, entry]);
      } catch (error) {
        entry.state = "removing";
        await this.write([...rows, entry]);
        // The request may have committed before a connection failed. Query ownership before cleanup.
        if (!(await this.registry.installed()).some((row) => row.id === entry.id)) throw error;
        await this.registry.uninstall(entry.id);
        await rm(path.join(this.directory, entry.id), { recursive: true, force: true });
        await this.write(rows);
        throw error;
      }
    });
  }
  uninstall(id: string) {
    return this.exclusive(async () => {
      const rows = await this.read();
      const entry = rows.find((row) => row.id === id);
      if (entry) {
        entry.state = "removing";
        await this.write(rows);
      }
      await this.registry.uninstall(id);
      if (entry) await rm(path.join(this.directory, entry.id), { recursive: true, force: true });
      await this.write(rows.filter((row) => row.id !== id));
    });
  }
  recover() {
    return this.exclusive(async () => {
      const rows = await this.read();
      const installed = new Map(
        (await this.registry.installed()).map((row) => [row.id, row.state]),
      );
      const retained: Installed[] = [];
      for (const row of rows) {
        if (
          installed.get(row.id) !== "installed" &&
          row.state !== "installed" &&
          this.now() - row.createdAt < 15 * 60_000
        ) {
          retained.push(row);
          continue;
        }
        if (row.state === "removing" || installed.get(row.id) !== "installed") {
          if (installed.has(row.id)) await this.registry.uninstall(row.id);
          await rm(path.join(this.directory, row.id), { recursive: true, force: true });
        } else retained.push({ ...row, state: "installed" });
      }
      await this.write(retained);
    });
  }
}
