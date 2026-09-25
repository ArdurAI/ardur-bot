import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { HostSecretStorage } from "../host-service.js";
import { hostStorageAvailable } from "../host-service.js";
import { readPrivateFile, writePrivateFile } from "../setup-store.js";
import type { BundleFile } from "./files.js";
import { bundleDocument, validateBundleFiles, writeBundleFiles } from "./files.js";
import type { ConfigValue, McpbManifest, ServerLaunch } from "./manifest.js";
import {
  configurationFields,
  parseMcpbManifest,
  resolveMcpbLaunch,
  validateUserConfig,
} from "./manifest.js";

export interface ExtensionRecord {
  id: string;
  manifest: McpbManifest;
  config: Record<string, ConfigValue>;
  installedAt: string;
  state: "installing" | "installed" | "removing";
}
export interface ExtensionRegistration {
  id: string;
  name: string;
  description: string;
  secretValues: string[];
  launch: ServerLaunch & { cwd: string };
}
export interface ExtensionRegistry {
  /** Idempotent; the same id replaces only this owner's managed registration. */
  upsert(server: ExtensionRegistration): Promise<void>;
  remove(id: string): Promise<void>;
}

/** All metadata and configuration use the existing Electron encrypted-storage boundary. */
export class ExtensionStore {
  private readonly stateFile: string;
  private readonly previews = new Map<
    string,
    { files: BundleFile[]; manifest: McpbManifest; expires: number }
  >();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly storage: HostSecretStorage,
    private readonly registry: ExtensionRegistry,
    private readonly variables: Record<string, string>,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly now = Date.now,
  ) {
    this.stateFile = path.join(directory, "extensions.enc");
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private requireStorage() {
    if (!hostStorageAvailable(this.storage, this.platform))
      throw new Error("Unlock secure storage, then try again.");
  }
  private async read(): Promise<ExtensionRecord[]> {
    this.requireStorage();
    const text = await readPrivateFile(this.stateFile, 8 * 1024 * 1024);
    if (text === null) {
      const exists = await lstat(this.stateFile).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (exists)
        throw new Error("Extension settings could not be read. Restore your settings backup.");
      return [];
    }
    try {
      const records: unknown = JSON.parse(this.storage.decryptString(Buffer.from(text, "base64")));
      if (!Array.isArray(records) || records.length > 100) throw new Error();
      return records.map((entry) => {
        if (
          !entry ||
          !/^[a-f0-9-]{36}$/.test(entry.id) ||
          !["installing", "installed", "removing"].includes(entry.state) ||
          typeof entry.installedAt !== "string"
        )
          throw new Error();
        const manifest = parseMcpbManifest(entry.manifest, this.platform);
        return {
          id: entry.id,
          manifest,
          config: validateUserConfig(manifest, entry.config),
          installedAt: entry.installedAt,
          state: entry.state,
        };
      });
    } catch {
      throw new Error(
        "Extension settings could not be decrypted. Unlock secure storage or restore your settings backup.",
      );
    }
  }
  private async write(records: ExtensionRecord[]) {
    this.requireStorage();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const encrypted = this.storage.encryptString(JSON.stringify(records)).toString("base64");
    if (encrypted.length > 8 * 1024 * 1024) throw new Error("Extension settings are too large.");
    await writePrivateFile(this.stateFile, encrypted);
  }
  private registration(entry: ExtensionRecord): ExtensionRegistration {
    return {
      id: entry.id,
      name: entry.manifest.display_name ?? entry.manifest.name,
      description: entry.manifest.description,
      secretValues: Object.entries(entry.manifest.user_config)
        .filter(([, field]) => field.sensitive)
        .flatMap(([key]) => {
          const value = entry.config[key];
          return value === undefined ? [] : Array.isArray(value) ? value : [String(value)];
        }),
      launch: resolveMcpbLaunch(entry.manifest, {
        directory: path.join(this.directory, entry.id),
        platform: this.platform,
        variables: this.variables,
        config: entry.config,
      }),
    };
  }
  private summary(entry: ExtensionRecord) {
    return {
      id: entry.id,
      name: entry.manifest.display_name ?? entry.manifest.name,
      version: entry.manifest.version,
      description: entry.manifest.description,
      installedAt: entry.installedAt,
      state: entry.state,
      fields: configurationFields(entry.manifest, entry.config),
    };
  }
  async list() {
    return (await this.read()).map((entry) => this.summary(entry));
  }

  prepare(files: BundleFile[]) {
    this.requireStorage();
    validateBundleFiles(files);
    const document = bundleDocument(files, "manifest.json");
    if (!document) throw new Error("Choose a bundle containing manifest.json.");
    let manifest: McpbManifest;
    try {
      manifest = parseMcpbManifest(JSON.parse(document), this.platform);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("The bundle manifest is not valid JSON.");
      throw error;
    }
    if (!files.some((entry) => entry.path === manifest.server.entry_point))
      throw new Error("The bundle is missing its server entry point.");
    for (const [id, preview] of this.previews)
      if (preview.expires < this.now()) this.previews.delete(id);
    if (this.previews.size >= 2) throw new Error("Finish or cancel the pending install first.");
    const id = randomUUID();
    this.previews.set(id, {
      files: files.map((file) => ({ ...file, bytes: file.bytes.slice() })),
      manifest,
      expires: this.now() + 15 * 60_000,
    });
    return {
      id,
      name: manifest.display_name ?? manifest.name,
      description: manifest.description,
      version: manifest.version,
      tools: manifest.tools,
      fields: configurationFields(manifest, {}),
      runtimes: manifest.compatibility.runtimes,
    };
  }
  cancel(id: string) {
    this.previews.delete(id);
  }

  install(previewId: string, config: unknown) {
    return this.exclusive(async () => {
      const preview = this.previews.get(previewId);
      if (!preview || preview.expires < this.now())
        throw new Error("Choose the bundle again to review its install.");
      const records = await this.read();
      if (records.length >= 100) throw new Error("Remove an extension before adding another.");
      if (records.some((entry) => entry.manifest.name === preview.manifest.name))
        throw new Error("This extension is already installed.");
      const entry: ExtensionRecord = {
        id: randomUUID(),
        manifest: preview.manifest,
        config: validateUserConfig(preview.manifest, config),
        installedAt: new Date(this.now()).toISOString(),
        state: "installing",
      };
      const registration = this.registration(entry);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // The authoritative manifest is encrypted. Keep a readable package manifest
      // for servers that inspect their own metadata, without launch credentials or sensitive defaults.
      const diskManifest = {
        ...entry.manifest,
        server: {
          type: entry.manifest.server.type,
          entry_point: entry.manifest.server.entry_point,
          mcp_config: { command: "[encrypted]" },
        },
        user_config: Object.fromEntries(
          Object.entries(entry.manifest.user_config).map(([key, field]) => {
            const { default: initial, ...definition } = field;
            return [
              key,
              field.sensitive
                ? definition
                : { ...definition, ...(initial === undefined ? {} : { default: initial }) },
            ];
          }),
        ),
      };
      await this.write([...records, entry]);
      try {
        await writeBundleFiles(path.join(this.directory, entry.id), [
          ...preview.files.filter((file) => file.path !== "manifest.json"),
          { path: "manifest.json", bytes: Buffer.from(JSON.stringify(diskManifest)) },
        ]);
        await this.registry.upsert(registration);
        entry.state = "installed";
        await this.write([...records, entry]);
      } catch (error) {
        // Keep a durable removing record if remote cleanup fails; recover() retries it.
        entry.state = "removing";
        await this.write([...records, entry]);
        await this.registry.remove(entry.id);
        await rm(path.join(this.directory, entry.id), { recursive: true, force: true });
        await this.write(records);
        throw error;
      }
      this.previews.delete(previewId);
      return this.summary(entry);
    });
  }

  configure(id: string, values: unknown) {
    return this.exclusive(async () => {
      const records = await this.read();
      const entry = records.find((row) => row.id === id && row.state === "installed");
      if (!entry) throw new Error("Choose an installed extension.");
      if (!values || typeof values !== "object" || Array.isArray(values))
        throw new Error("Check the configuration fields.");
      entry.config = validateUserConfig(entry.manifest, { ...entry.config, ...values });
      const registration = this.registration(entry);
      // Persist first: a crash is repaired from encrypted desired state at activation.
      await this.write(records);
      await this.registry.upsert(registration);
      return this.summary(entry);
    });
  }
  uninstall(id: string) {
    return this.exclusive(async () => {
      const records = await this.read();
      const entry = records.find((row) => row.id === id);
      if (!entry) return;
      entry.state = "removing";
      await this.write(records);
      await this.registry.remove(id);
      await rm(path.join(this.directory, id), { recursive: true, force: true });
      await this.write(records.filter((row) => row.id !== id));
    });
  }
  recover() {
    return this.exclusive(async () => {
      const records = await this.read();
      const retained: ExtensionRecord[] = [];
      for (const entry of records) {
        if (entry.state !== "installed") {
          await this.registry.remove(entry.id);
          await rm(path.join(this.directory, entry.id), { recursive: true, force: true });
        } else {
          await this.registry.upsert(this.registration(entry));
          entry.state = "installed";
          retained.push(entry);
        }
      }
      await this.write(retained);
    });
  }
}
