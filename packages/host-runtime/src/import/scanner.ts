import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  LocalImportCategory,
  LocalImportItem,
  LocalImportManifest,
  LocalImportRead,
  LocalImportTool,
} from "@ardurbot/contracts/local-import";
import {
  LOCAL_IMPORT_BYTES,
  LOCAL_IMPORT_CATEGORIES,
  LOCAL_IMPORT_ITEMS,
  LOCAL_IMPORT_TOOLS,
  LocalImportManifestSchema,
  LocalImportReadSchema,
} from "@ardurbot/contracts/local-import";
import { parseSkillMd } from "@ardurbot/core";
import { getHostEnvironment } from "../host-environment.js";
import { object, parseConfig, safeName, safeText, serverDefinition } from "./formats.js";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_DIRECTORIES = 4096;
const EXCLUDED =
  /^(?:auth(?:\..*)?|credentials?(?:\..*)?|oauth_creds(?:\..*)?|mcp-oauth|cookies?(?:\..*)?|tokens?(?:\..*)?|(?:imported_)?sessions?|transcripts?|chats?|chat[-_]histor(?:y|ies)|(?:user-)?history(?:\..*)?|telemetry|caches?|\.git|node_modules|\.env(?:\..*)?|\.ssh|\.gnupg|\.aws|\.azure|Keychains|id_(?:rsa|ed25519|ecdsa|dsa))$/iu;
export function excludedImportPath(value: string) {
  return value
    .split(/[/\\]/u)
    .some(
      (part) =>
        EXCLUDED.test(part) ||
        /^\.?(?:auth|credentials?|oauth(?:[_-](?:creds|tokens?))?|cookies?|tokens?|mcp-oauth|sessions?|transcripts?|chat[-_]history|user[-_]history|telemetry|caches?)(?:[._-].*)?$/iu.test(
          part,
        ) ||
        /\.(?:bak|backup|jsonl|log|pem|key|p12|pfx)$/iu.test(part),
    );
}
export function importHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function localImportDefaults(platform: string, env: Record<string, string | undefined>) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const home = platform === "win32" ? (env.USERPROFILE ?? env.HOME) : env.HOME;
  if (!home || !p.isAbsolute(home)) throw new Error("The owner's home is unavailable.");
  const roots: Partial<Record<LocalImportTool, string>> = {};
  for (const [tool, folder] of [
    ["claude-code", ".claude"],
    ["codex", ".codex"],
    ["kimi", ".kimi"],
    ["cursor", ".cursor"],
    ["gemini", ".gemini"],
    ["hermes", ".hermes"],
  ] as const)
    roots[tool] = p.join(home, folder);
  if (platform === "darwin")
    roots["claude-desktop"] = p.join(home, "Library/Application Support/Claude");
  if (platform === "win32")
    roots["claude-desktop"] = p.join(env.APPDATA ?? p.join(home, "AppData/Roaming"), "Claude");
  return { home, roots };
}
type Options = {
  home: string;
  appData?: string;
  platform?: "darwin" | "linux" | "win32";
  registeredFolders?: string[];
  clock?: () => Date;
};
type Candidate = {
  tool: LocalImportTool;
  category: LocalImportCategory;
  file: string;
  content?: string;
  name?: string;
  key?: string;
  reason?: string;
  folder?: string;
  server?: LocalImportRead["server"];
  metadata?: { size: number; mtime: Date };
};

/** Only this host-owned object retains sanitized bodies. The manifest contains metadata only. */
export class LocalImportScanner {
  private home = "";
  private items = new Map<string, LocalImportRead>();
  private manifest: LocalImportManifest | null = null;
  private bytes = 0;
  private visited = 0;
  private limited = false;
  private scanning = false;
  constructor(private readonly options: Options) {}

  private contained(value: string) {
    const relative = path.relative(this.home, value);
    return (
      relative === "" || (!relative.split(path.sep).includes("..") && !path.isAbsolute(relative))
    );
  }
  private async resolve(file: string) {
    if (excludedImportPath(file) || !this.contained(path.resolve(file)))
      throw new Error("Excluded source.");
    const resolved = await realpath(file);
    if (!this.contained(resolved) || excludedImportPath(resolved))
      throw new Error("Excluded source.");
    return resolved;
  }
  private async file(file: string, limit = MAX_SOURCE_BYTES) {
    const resolved = await this.resolve(file);
    const initial = await lstat(resolved);
    if (!initial.isFile() || initial.nlink > 1 || initial.size > limit)
      throw new Error("Source is unavailable or too large.");
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        resolved,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const info = await handle.stat();
      const current = await stat(resolved);
      if (
        !info.isFile() ||
        info.nlink > 1 ||
        info.size > limit ||
        info.ino !== current.ino ||
        info.dev !== current.dev ||
        (await this.resolve(file)) !== resolved
      )
        throw new Error("Source is unavailable or too large.");
      const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await handle.stat();
      if (length > limit || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
        throw new Error("Source changed; re-scan.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      if (text.includes("\0")) throw new Error("Binary source.");
      return { text, info, resolved };
    } finally {
      await handle?.close();
    }
  }
  private async entries(dir: string) {
    if (++this.visited > MAX_DIRECTORIES) {
      this.limited = true;
      return [];
    }
    try {
      const resolved = await this.resolve(dir);
      const entries: string[] = [];
      const directory = await opendir(resolved);
      for await (const entry of directory) {
        if (entries.length >= LOCAL_IMPORT_ITEMS) {
          this.limited = true;
          break;
        }
        entries.push(entry.name);
      }
      return entries
        .filter((name) => !excludedImportPath(name))
        .sort()
        .slice(0, LOCAL_IMPORT_ITEMS);
    } catch {
      return [];
    }
  }
  private async exists(file: string) {
    try {
      await this.resolve(file);
      return true;
    } catch {
      return false;
    }
  }
  private async add(candidate: Candidate) {
    if (this.items.size >= LOCAL_IMPORT_ITEMS || this.bytes >= MAX_RETAINED_BYTES) {
      this.limited = true;
      return;
    }
    try {
      // Report-only files need metadata, never their body (plans, hooks, unsupported assets).
      const reportInfo =
        candidate.reason && !candidate.metadata
          ? await stat(await this.resolve(candidate.file))
          : undefined;
      const source = candidate.metadata || reportInfo ? undefined : await this.file(candidate.file);
      const metadata = candidate.metadata ?? reportInfo ?? source!.info;
      const raw = candidate.content ?? source?.text ?? "";
      const content = candidate.reason ? "" : safeText(raw);
      const size = Buffer.byteLength(content);
      if (size > LOCAL_IMPORT_BYTES || this.bytes + size > MAX_RETAINED_BYTES) {
        this.limited = true;
        candidate.reason = "This item exceeds the import size limit.";
      }
      const relative = path.relative(this.home, candidate.file).split(path.sep).join("/");
      const relativePath = safeName(relative, "Redacted source path", 1024);
      const sourcePathHash = importHash(`${relative}\0${candidate.key ?? ""}`);
      if (
        [...this.items.values()].some(
          (entry) =>
            entry.item.sourcePathHash === sourcePathHash && entry.item.tool === candidate.tool,
        )
      )
        return;
      let name = safeName(candidate.name ?? path.basename(candidate.file));
      if (candidate.category === "skills" && !candidate.reason) {
        const skill = parseSkillMd(content);
        if ("error" in skill)
          candidate.reason = "The skill does not have supported name and description frontmatter.";
        else name = safeName(skill.name);
      }
      const body = candidate.reason ? "" : content;
      const item: LocalImportItem = {
        id: randomUUID(),
        tool: candidate.tool,
        category: candidate.category,
        name,
        relativePath,
        sourcePathHash,
        // Hash the eligible projection, so changing discarded credentials never creates a revision.
        contentHash: importHash(candidate.reason ? `${sourcePathHash}\0${candidate.reason}` : body),
        size: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
        importable: !candidate.reason,
        ...(candidate.reason ? { reason: candidate.reason } : {}),
        ...(candidate.folder
          ? { folder: importHash(path.relative(this.home, candidate.folder)) }
          : {}),
      };
      const result = LocalImportReadSchema.parse({
        item,
        content: body,
        ...(candidate.server && !candidate.reason ? { server: candidate.server } : {}),
      });
      this.items.set(item.id, result);
      this.bytes += Buffer.byteLength(body);
    } catch {
      // Missing, denied, replaced, binary and malformed files never leak parser input or paths.
    }
  }
  private async markdown(
    tool: LocalImportTool,
    dir: string,
    category: LocalImportCategory,
    depth = 0,
    reason?: string,
    folder?: string,
  ) {
    if (depth > 4) {
      this.limited = true;
      return;
    }
    for (const name of await this.entries(dir)) {
      const file = path.join(dir, name);
      try {
        const info = await stat(await this.resolve(file));
        if (info.isDirectory())
          await this.markdown(tool, file, category, depth + 1, reason, folder);
        else if (/\.(?:md|mdc|txt)$/iu.test(name))
          await this.add({ tool, category, file, reason, folder });
      } catch {
        /* Excluded source. */
      }
    }
  }
  private async skills(tool: LocalImportTool, root: string, depth = 0) {
    if (depth > 4) {
      this.limited = true;
      return;
    }
    for (const name of await this.entries(root)) {
      const folder = path.join(root, name);
      try {
        if (!(await stat(await this.resolve(folder))).isDirectory()) continue;
      } catch {
        continue;
      }
      const file = path.join(folder, "SKILL.md");
      if (!(await this.exists(file))) {
        await this.skills(tool, folder, depth + 1);
        continue;
      }
      await this.add({ tool, category: "skills", file });
      const assets = (await this.entries(folder)).filter((entry) => entry !== "SKILL.md");
      if (assets.length)
        await this.add({
          tool,
          category: "other",
          file: folder,
          name: `Supporting files for ${safeName(name)}`,
          reason: "Only SKILL.md is imported; supporting files are not installed.",
        });
    }
  }
  private async config(tool: LocalImportTool, file: string) {
    if (!(await this.exists(file))) return;
    try {
      const source = await this.file(file);
      const config = parseConfig(source.text, file.endsWith(".toml") ? "toml" : "json");
      const servers = object(config.mcpServers ?? config.mcp_servers);
      if (!Object.keys(servers).length && tool !== "codex")
        await this.add({
          tool,
          category: "other",
          file,
          metadata: source.info,
          reason: "No supported server definitions were found in this configuration.",
        });
      for (const [name, raw] of Object.entries(servers)) {
        const server = serverDefinition(name, raw, tool);
        await this.add({
          tool,
          category: "servers",
          file,
          name,
          key: `server:${name}`,
          metadata: source.info,
          ...(server
            ? { server, content: JSON.stringify(server, null, 2) }
            : {
                reason:
                  "This server has unsupported configuration or credential-bearing arguments.",
              }),
        });
      }
      if (tool === "codex") {
        if (typeof config.developer_instructions === "string")
          await this.add({
            tool,
            category: "instructions",
            file,
            key: "developer_instructions",
            name: "Developer instructions",
            content: config.developer_instructions,
            metadata: source.info,
          });
        if (typeof config.model_instructions_file === "string") {
          const value = config.model_instructions_file;
          const target = value.startsWith("~/")
            ? path.join(this.home, value.slice(2))
            : path.resolve(path.dirname(file), value);
          await this.add({
            tool,
            category: "instructions",
            file: target,
            ...(!/\.(?:md|txt)$/iu.test(target)
              ? { reason: "The instructions file must be Markdown or plain text." }
              : {}),
          });
        }
      }
    } catch {
      await this.add({
        tool,
        category: "other",
        file,
        reason: "This configuration format is unsupported or malformed.",
      });
    }
  }
  private async plugins(root: string) {
    const installed = path.join(root, "plugins/installed_plugins.json");
    try {
      const source = await this.file(installed);
      for (const name of Object.keys(object(object(JSON.parse(source.text)).plugins)))
        await this.add({
          tool: "claude-code",
          category: "plugins",
          file: installed,
          name,
          key: name,
          metadata: source.info,
          reason: "Plugins are not yet importable in this build.",
        });
    } catch {
      /* The registry is optional and its internal format is not a stable contract. */
    }
    const walk = async (dir: string, depth: number) => {
      if (depth > 3) return;
      const manifest = path.join(dir, ".claude-plugin/plugin.json");
      if (await this.exists(manifest)) {
        try {
          const source = await this.file(manifest);
          const config = object(JSON.parse(source.text));
          await this.add({
            tool: "claude-code",
            category: "plugins",
            file: manifest,
            name: typeof config.name === "string" ? config.name : path.basename(dir),
            metadata: source.info,
            reason: "Plugins are not yet importable in this build.",
          });
        } catch {
          /* Do not expose the manifest. */
        }
        return;
      }
      for (const entry of await this.entries(dir)) {
        const child = path.join(dir, entry);
        try {
          if ((await stat(await this.resolve(child))).isDirectory()) await walk(child, depth + 1);
        } catch {
          /* Optional. */
        }
      }
    };
    await walk(path.join(root, "plugins/marketplaces"), 0);
  }
  private async desktop(root: string) {
    await this.config("claude-desktop", path.join(root, "claude_desktop_config.json"));
    for (const name of await this.entries(path.join(root, "Claude Extensions"))) {
      const file = path.join(root, "Claude Extensions", name, "manifest.json");
      try {
        const source = await this.file(file);
        const manifest = object(JSON.parse(source.text));
        // Recognize MCPB/DXT metadata, but do not run entrypoints or resolve user_config.
        const server = object(manifest.server);
        const valid =
          typeof (manifest.manifest_version ?? manifest.dxt_version) === "string" &&
          typeof manifest.name === "string" &&
          Object.keys(object(server.mcp_config)).length > 0;
        await this.add({
          tool: "claude-desktop",
          category: "plugins",
          file,
          name: valid ? String(manifest.name) : name,
          metadata: source.info,
          reason: valid
            ? "Extensions are not yet importable in this build."
            : "This extension manifest is unsupported.",
        });
      } catch {
        /* Optional or malformed manifest. */
      }
    }
  }
  private async sqlite(root: string) {
    for (const name of await this.entries(root)) {
      if (!/^memories_[A-Za-z0-9_-]+\.sqlite$/u.test(name)) continue;
      const file = path.join(root, name);
      let db: DatabaseSync | undefined;
      try {
        const resolved = await this.resolve(file);
        const info = await lstat(resolved);
        if (!info.isFile() || info.nlink > 1 || info.size > 64 * 1024 * 1024)
          throw new Error("Unsupported database.");
        db = new DatabaseSync(resolved, {
          readOnly: true,
          enableDoubleQuotedStringLiterals: false,
          allowExtension: false,
        });
        db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND sql NOT LIKE '%VIRTUAL%' LIMIT 32",
          )
          .all();
        let found = false;
        for (const row of tables) {
          const table = String(row.name);
          if (
            !/memor/iu.test(table) ||
            excludedImportPath(table) ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(table)
          )
            continue;
          const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
          const fields = columns
            .filter(
              (column) =>
                /^(?:content|text|memory|raw_memory|summary|description|name)$/u.test(
                  String(column.name),
                ) && /(?:TEXT|CHAR|CLOB)/iu.test(String(column.type)),
            )
            .map((column) => String(column.name));
          if (!fields.length) continue;
          // Never SELECT *: schemas can include credential, session and transcript columns.
          const rows = db
            .prepare(
              `SELECT rowid AS import_row, ${fields.map((field) => `substr("${field}",1,${LOCAL_IMPORT_BYTES + 1}) AS "${field}"`).join(",")} FROM "${table}" ORDER BY rowid LIMIT 1025`,
            )
            .all();
          if (rows.length > 1024) this.limited = true;
          for (const memory of rows.slice(0, 1024)) {
            const content = fields
              .flatMap((field) =>
                typeof memory[field] === "string" ? [String(memory[field])] : [],
              )
              .join("\n\n");
            if (!content.trim()) continue;
            found = true;
            await this.add({
              tool: "codex",
              category: "memories",
              file,
              key: `${table}:${memory.import_row}`,
              name: `Memory ${memory.import_row}`,
              content,
              metadata: info,
            });
          }
        }
        if (!found)
          await this.add({
            tool: "codex",
            category: "other",
            file,
            metadata: info,
            reason: "No supported memory text fields were found in this database.",
          });
      } catch {
        try {
          const info = await stat(await this.resolve(file));
          await this.add({
            tool: "codex",
            category: "other",
            file,
            metadata: info,
            reason: "This memory database schema is unsupported or unavailable.",
          });
        } catch {
          /* Excluded source. */
        }
      } finally {
        db?.close();
      }
    }
  }
  async scan(
    overrides: Partial<Record<LocalImportTool, string>> = {},
  ): Promise<LocalImportManifest> {
    if (this.scanning) throw new Error("A scan is already running.");
    this.scanning = true;
    this.items.clear();
    this.manifest = null;
    this.bytes = 0;
    this.visited = 0;
    this.limited = false;
    try {
      this.home = await realpath(this.options.home);
      const platform = this.options.platform ?? (process.platform as Options["platform"]);
      const defaults = localImportDefaults(platform!, {
        HOME: this.home,
        USERPROFILE: this.home,
        APPDATA: this.options.appData,
      });
      const sources: LocalImportManifest["sources"] = [];
      for (const tool of LOCAL_IMPORT_TOOLS) {
        const defaultRoot = defaults.roots[tool];
        if (!defaultRoot) continue;
        const defaultMissing = !(await this.exists(defaultRoot));
        const root =
          defaultMissing && overrides[tool]
            ? path.resolve(this.home, overrides[tool]!)
            : defaultRoot;
        const detected = await this.exists(root);
        sources.push({
          tool,
          detected,
          defaultMissing,
          counts: Object.fromEntries(
            LOCAL_IMPORT_CATEGORIES.map((category) => [category, 0]),
          ) as Record<LocalImportCategory, number>,
          memoryFolders: 0,
        });
        if (!detected && tool !== "claude-code") continue;
        if (tool === "claude-code") {
          await this.add({ tool, category: "instructions", file: path.join(root, "CLAUDE.md") });
          for (const project of await this.entries(path.join(root, "projects"))) {
            const memory = path.join(root, "projects", project, "memory");
            await this.markdown(tool, memory, "memories", 0, undefined, memory);
          }
          await this.skills(tool, path.join(root, "skills"));
          await this.config(tool, path.join(root, "settings.json"));
          await this.config(tool, path.join(this.home, ".claude.json"));
          await this.plugins(root);
        } else if (tool === "codex") {
          await this.add({ tool, category: "instructions", file: path.join(root, "AGENTS.md") });
          await this.skills(tool, path.join(root, "skills"));
          await this.config(tool, path.join(root, "config.toml"));
          await this.sqlite(root);
        } else if (tool === "kimi") {
          for (const name of ["config.toml", "kimi.json", "mcp.json"])
            await this.config(tool, path.join(root, name));
          await this.markdown(
            tool,
            path.join(root, "plans"),
            "other",
            0,
            "Plans are not imported as durable instructions.",
          );
        } else if (tool === "cursor") {
          await this.config(tool, path.join(root, "mcp.json"));
          await this.markdown(tool, path.join(root, "rules"), "instructions");
          for (const dir of ["skills", "skills-cursor"])
            await this.skills(tool, path.join(root, dir));
          await this.markdown(
            tool,
            path.join(root, "agents"),
            "other",
            0,
            "Agent definitions are not imported as skills.",
          );
          if (await this.exists(path.join(root, "hooks.json"))) {
            const file = path.join(root, "hooks.json");
            const info = await stat(await this.resolve(file));
            await this.add({
              tool,
              category: "other",
              file,
              metadata: info,
              reason: "Hooks are reported only and never executed.",
            });
          }
        } else if (tool === "gemini") {
          await this.add({ tool, category: "instructions", file: path.join(root, "GEMINI.md") });
          await this.skills(tool, path.join(root, "skills"));
          await this.config(tool, path.join(root, "settings.json"));
        } else if (tool === "hermes") {
          await this.add({ tool, category: "instructions", file: path.join(root, "SOUL.md") });
          await this.skills(tool, path.join(root, "skills"));
          const file = path.join(root, "config.yaml");
          try {
            const source = await this.file(file);
            const names = [
              ...source.text.matchAll(
                /^\s*(?:model|provider|default):\s*["']?([A-Za-z0-9_./:-]+)["']?\s*$/gmu,
              ),
            ].map((match) => safeName(match[1]!));
            await this.add({
              tool,
              category: "other",
              file,
              name: names.length ? names.slice(0, 3).join(" / ") : "Model configuration",
              metadata: source.info,
              reason: "Model and provider names are reported only.",
            });
          } catch {
            /* No configuration values are returned. */
          }
        } else await this.desktop(root);
      }
      for (const folder of (this.options.registeredFolders ?? []).slice(0, 32)) {
        if (!(await this.exists(folder))) continue;
        await this.add({
          tool: "claude-code",
          category: "instructions",
          file: path.join(folder, "CLAUDE.md"),
        });
        await this.add({
          tool: "codex",
          category: "instructions",
          file: path.join(folder, "AGENTS.md"),
        });
        await this.add({
          tool: "cursor",
          category: "instructions",
          file: path.join(folder, ".cursorrules"),
        });
        await this.markdown("cursor", path.join(folder, ".cursor/rules"), "instructions");
      }
      const items = [...this.items.values()].map((entry) => entry.item);
      for (const source of sources) {
        const own = items.filter((item) => item.tool === source.tool);
        source.detected ||= own.length > 0;
        for (const item of own) source.counts[item.category]++;
        source.memoryFolders = new Set(
          own.flatMap((item) => (item.folder ? [item.folder] : [])),
        ).size;
      }
      this.manifest = LocalImportManifestSchema.parse({
        scanId: randomUUID(),
        scannedAt: (this.options.clock?.() ?? new Date()).toISOString(),
        platform,
        sources,
        items,
        limited: this.limited,
      });
      return structuredClone(this.manifest);
    } finally {
      this.scanning = false;
    }
  }
  read(scanId: string, itemId: string): LocalImportRead {
    if (this.scanning || !this.manifest || this.manifest.scanId !== scanId)
      throw new Error("Re-scan this computer before previewing or importing.");
    const value = this.items.get(itemId);
    if (!value?.item.importable) throw new Error("This item is not available for import.");
    return LocalImportReadSchema.parse(structuredClone(value));
  }
}

export async function createLocalImportScanner(registeredFolders: string[] = []) {
  const snapshot = await getHostEnvironment();
  const { home } = localImportDefaults(process.platform, snapshot.env);
  return new LocalImportScanner({ home, registeredFolders, appData: snapshot.env.APPDATA });
}
