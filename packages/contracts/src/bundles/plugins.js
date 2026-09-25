import { createHash } from "node:crypto";
import { bundleDocument, bundlePath, validateBundleFiles } from "./files.js";
import { manifestText, record } from "./manifest.js";

const componentKeys = ["skills", "commands", "mcpServers", "outputStyles"];
const identifier = (value) => {
  const name = manifestText(value, 100);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Use a plugin name in kebab-case.");
  return name;
};
function textList(value) {
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error("The plugin manifest contains an invalid list.");
  return value.map((entry) => manifestText(entry));
}
function componentPath(value) {
  const text = manifestText(value);
  if (text === "." || text === "./") return "";
  if (!text.startsWith("./")) throw new Error("Plugin component paths must start with ./.");
  return bundlePath(text.replace(/\/$/, ""));
}
function componentPaths(value) {
  return value === undefined
    ? undefined
    : (Array.isArray(value) ? textList(value) : [manifestText(value)]).map(componentPath);
}
function stringMap(value, header = false) {
  const entries = Object.entries(record(value ?? {}));
  if (entries.length > 64) throw new Error("The server has too many configuration entries.");
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (!(header ? /^[A-Za-z0-9-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(key))
        throw new Error("The server contains an invalid configuration key.");
      return [key, value === "" ? "" : manifestText(value)];
    }),
  );
}
export function parsePluginServers(value) {
  const data = record(value);
  const servers = record(data.mcpServers ?? data);
  if (Object.keys(servers).length > 64) throw new Error("The plugin has too many servers.");
  return Object.fromEntries(
    Object.entries(servers).map(([key, value]) => {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key))
        throw new Error("The plugin contains an invalid server name.");
      const data = record(value);
      if (data.type !== undefined && !["stdio", "http", "sse"].includes(String(data.type)))
        throw new Error("The plugin uses an unsupported MCP transport.");
      if (data.url !== undefined) {
        const url = new URL(manifestText(data.url));
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.hash ||
          data.command !== undefined ||
          data.type === "stdio"
        )
          throw new Error("Remote plugin servers require HTTPS without URL credentials.");
        return [
          key,
          {
            type: data.type === "sse" ? "sse" : "http",
            url: url.href,
            headers: stringMap(data.headers, true),
          },
        ];
      }
      if (data.type === "http" || data.type === "sse")
        throw new Error("The remote server needs a URL.");
      return [
        key,
        {
          type: "stdio",
          command: manifestText(data.command, 512),
          args: data.args === undefined ? [] : textList(data.args),
          env: stringMap(data.env),
        },
      ];
    }),
  );
}
/** Only documented component fields are interpreted. Unknown metadata cannot execute. */
export function parsePluginJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The plugin manifest is not valid JSON.");
  }
}
export function parsePluginManifest(value) {
  const data = record(value);
  const unsupported = [
    "hooks",
    "agents",
    "lspServers",
    "workflows",
    "experimental",
    "dependencies",
    "channels",
    "userConfig",
  ].filter((key) => data[key] !== undefined);
  return {
    name: identifier(data.name),
    ...(data.description === undefined
      ? {}
      : { description: manifestText(data.description, 2000) }),
    ...(data.version === undefined ? {} : { version: manifestText(data.version, 100) }),
    ...(data.author === undefined
      ? {}
      : { author: { name: manifestText(record(data.author).name, 200) } }),
    ...(data.keywords === undefined ? {} : { keywords: textList(data.keywords) }),
    skills: componentPaths(data.skills),
    commands: componentPaths(data.commands),
    outputStyles: componentPaths(data.outputStyles),
    ...(data.mcpServers === undefined
      ? {}
      : {
          mcpServers:
            typeof data.mcpServers === "string" || Array.isArray(data.mcpServers)
              ? componentPaths(data.mcpServers)
              : parsePluginServers(data.mcpServers),
        }),
    unsupported,
  };
}
export function parseMarketplace(value) {
  const data = record(value);
  const owner = record(data.owner);
  if (!Array.isArray(data.plugins) || data.plugins.length > 500)
    throw new Error("The marketplace has an invalid plugin list.");
  const names = new Set();
  const pluginRoot = data.metadata === undefined ? "" : record(data.metadata).pluginRoot;
  const root = pluginRoot === undefined || pluginRoot === "" ? "" : componentPath(pluginRoot);
  const plugins = data.plugins.map((value) => {
    const entry = record(value);
    const manifest = parsePluginManifest(entry);
    if (names.has(manifest.name)) throw new Error("The marketplace repeats a plugin name.");
    names.add(manifest.name);
    let source;
    if (typeof entry.source === "string") {
      const raw = entry.source;
      source = raw.startsWith("./")
        ? componentPath(raw)
        : bundlePath(root ? `${root}/${raw}` : raw);
    } else {
      const data = record(entry.source);
      const pin = {
        ...(data.ref === undefined ? {} : { ref: manifestText(data.ref, 200) }),
        ...(data.sha === undefined ? {} : { sha: manifestText(data.sha, 64) }),
      };
      if (pin.sha && !/^[0-9a-f]{40,64}$/i.test(pin.sha))
        throw new Error("The plugin commit is invalid.");
      if (
        pin.ref &&
        (pin.ref.startsWith("-") ||
          /[~^:?*[\\]/u.test(pin.ref) ||
          Array.from(pin.ref).some((character) => character.charCodeAt(0) <= 32) ||
          pin.ref.includes(".."))
      )
        throw new Error("The plugin reference is invalid.");
      if (data.source === "github") {
        const repo = manifestText(data.repo, 200);
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
          throw new Error("The plugin repository is invalid.");
        source = { source: "github", repo, ...pin };
      } else if (data.source === "url") {
        const url = new URL(manifestText(data.url));
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
          throw new Error("Use an HTTPS Git URL without credentials.");
        source = { source: "url", url: url.href, ...pin };
      } else throw new Error("This marketplace uses an unsupported plugin source.");
    }
    if (entry.strict !== undefined && typeof entry.strict !== "boolean")
      throw new Error("The marketplace has an invalid strict flag.");
    return {
      ...manifest,
      source,
      strict: entry.strict !== false,
      ...(entry.category === undefined ? {} : { category: manifestText(entry.category, 100) }),
      ...(entry.tags === undefined ? {} : { tags: textList(entry.tags) }),
    };
  });
  return { name: identifier(data.name), owner: { name: manifestText(owner.name, 200) }, plugins };
}
export function pluginFiles(files, source) {
  const root = source === "" || source === "./" ? "" : `${bundlePath(source)}/`;
  return files
    .filter((file) => file.path.startsWith(root))
    .map((file) => ({ ...file, path: file.path.slice(root.length) }));
}
function markdownFiles(files, paths, skills) {
  return files
    .filter((file) =>
      paths.some((root) => !root || file.path === root || file.path.startsWith(`${root}/`)),
    )
    .filter((file) =>
      skills
        ? file.path.endsWith("/SKILL.md") || file.path === "SKILL.md"
        : file.path.endsWith(".md"),
    )
    .map((file) => ({ path: file.path, content: bundleDocument(files, file.path) }));
}
export function planPlugin(files, entry) {
  validateBundleFiles(files);
  const document = bundleDocument(files, ".claude-plugin/plugin.json");
  const manifest = document ? parsePluginManifest(parsePluginJson(document)) : entry;
  if (!manifest) throw new Error("The plugin needs a manifest or a marketplace entry.");
  if (
    entry?.strict === false &&
    document &&
    componentKeys.some((key) => manifest[key] !== undefined)
  )
    throw new Error("The marketplace and plugin define conflicting components.");
  const definition = entry?.strict === false ? entry : manifest;
  const supplements = entry?.strict === false || !document ? undefined : entry;
  const unsupported = [
    ...new Set([...definition.unsupported, ...(supplements?.unsupported ?? [])]),
  ];
  if (files.some((file) => file.path === "hooks/hooks.json")) unsupported.push("hooks");
  if (unsupported.length)
    throw new Error("This plugin contains components that are not supported here.");
  const name = entry?.name ?? definition.name;
  const skills = markdownFiles(
    files,
    [...new Set(["skills", ...(definition.skills ?? []), ...(supplements?.skills ?? [])])],
    true,
  );
  const commands = markdownFiles(
    files,
    [...new Set([...(definition.commands ?? ["commands"]), ...(supplements?.commands ?? [])])],
    false,
  );
  const instructions = markdownFiles(
    files,
    [
      ...new Set([
        ...(definition.outputStyles ?? ["output-styles"]),
        ...(supplements?.outputStyles ?? []),
      ]),
    ],
    false,
  );
  const servers = {};
  const configurationPaths = new Set([".claude-plugin/plugin.json", ".mcp.json"]);
  const addServers = (value) => {
    if (Array.isArray(value)) {
      for (const path of value) {
        configurationPaths.add(path);
        const text = bundleDocument(files, path);
        if (text === undefined) throw new Error("The plugin is missing an MCP configuration file.");
        Object.assign(servers, parsePluginServers(parsePluginJson(text)));
      }
    } else if (value) Object.assign(servers, value);
  };
  const defaults = bundleDocument(files, ".mcp.json");
  if (defaults) Object.assign(servers, parsePluginServers(parsePluginJson(defaults)));
  addServers(supplements?.mcpServers);
  addServers(definition.mcpServers);
  if (
    skills.length + commands.length + instructions.length > 200 ||
    Object.keys(servers).length > 64
  )
    throw new Error("The plugin adds too many components.");
  const digest = createHash("sha256");
  digest.update(JSON.stringify(entry ?? {}));
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    digest.update(JSON.stringify([file.path, file.bytes.byteLength, file.executable ?? false]));
    digest.update(file.bytes);
  }
  return {
    name,
    description: definition.description ?? entry?.description ?? "",
    version: definition.version ?? entry?.version,
    author: definition.author ?? entry?.author,
    skills,
    commands,
    instructions,
    servers,
    configurationPaths: [...configurationPaths],
    digest: digest.digest("hex"),
  };
}
/** Keep launch material in the encrypted store, never in the extracted package configuration. */
export function pluginInstallFiles(files, plan) {
  return files.map((file) =>
    plan.configurationPaths.includes(file.path)
      ? {
          ...file,
          bytes: Buffer.from(
            JSON.stringify(
              file.path === ".claude-plugin/plugin.json"
                ? { name: plan.name, version: plan.version, description: plan.description }
                : {},
            ),
          ),
        }
      : file,
  );
}
