import type { LocalImportServer } from "@ardurbot/contracts/local-import";
import { LocalImportServerSchema } from "@ardurbot/contracts/local-import";
import { McpRemoteEndpointSchema } from "@ardurbot/contracts/mcp";
import { redactLearningText } from "@ardurbot/core";

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function safeText(value: string) {
  return redactLearningText(value)
    .replace(
      /\b[A-Za-z0-9_-]*(?:credential|private[_-]?key|access[_-]?key|api[_-]?key|token|secret|password|passwd|authorization)[A-Za-z0-9_-]*["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/giu,
      "[Redacted]",
    )
    .replace(/([?&])[^=\s&]+=[^\s&"')]+/gu, "$1[Redacted]");
}
export function safeName(value: string, fallback = "Unnamed item", limit = 200) {
  const clean = Array.from(safeText(value))
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("")
    .slice(0, limit);
  return clean.includes("[Redacted]") ? fallback : clean || fallback;
}

/** Parse only data: no evaluation, substitutions, includes, commands or environment access. */
export function parseConfig(text: string, format: "json" | "toml") {
  if (format === "json") return object(JSON.parse(text));
  return parseToml(text);
}

// TOML dependencies in this workspace are transitive build dependencies. This bounded
// data-only subset handles the documented MCP tables, strings, arrays and inline maps.
// Unsupported or ambiguous syntax rejects the file instead of guessing its meaning.
export function parseToml(text: string): Record<string, unknown> {
  let offset = 0;
  const root: Record<string, unknown> = Object.create(null);
  let table = root;
  const skip = (newlines = true) => {
    while (offset < text.length) {
      if ((newlines ? /\s/u : /[ \t\r]/u).test(text[offset]!)) {
        offset++;
        continue;
      }
      if (text[offset] === "#") {
        while (offset < text.length && text[offset] !== "\n") offset++;
        continue;
      }
      break;
    }
  };
  const string = () => {
    const quote = text[offset++]!;
    const multiline = text.slice(offset, offset + 2) === quote.repeat(2);
    if (multiline) offset += 2;
    const start = offset;
    while (offset < text.length) {
      if (quote === '"' && text[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (text.slice(offset, offset + (multiline ? 3 : 1)) === quote.repeat(multiline ? 3 : 1)) {
        const raw = text.slice(start, offset);
        offset += multiline ? 3 : 1;
        if (quote === "'") return raw.replace(/^\r?\n/u, "");
        return JSON.parse(`"${raw.replace(/\r?\n/gu, "\\n").replace(/\t/gu, "\\t")}"`) as string;
      }
      offset++;
    }
    throw new Error("Unsupported configuration.");
  };
  const key = () => {
    skip(false);
    if (text[offset] === '"' || text[offset] === "'") return string();
    const match = /^[A-Za-z0-9_-]+/u.exec(text.slice(offset));
    if (!match) throw new Error("Unsupported configuration.");
    offset += match[0].length;
    return match[0];
  };
  const keys = () => {
    const result = [key()];
    skip(false);
    while (text[offset] === ".") {
      offset++;
      result.push(key());
      skip(false);
    }
    return result;
  };
  const assign = (target: Record<string, unknown>, parts: string[], value: unknown) => {
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(target, part)) target[part] = Object.create(null);
      if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part]))
        throw new Error("Unsupported configuration.");
      target = object(target[part]);
    }
    const last = parts.at(-1)!;
    if (Object.hasOwn(target, last)) throw new Error("Duplicate configuration key.");
    target[last] = value;
  };
  const value = (depth = 0): unknown => {
    if (depth > 8) throw new Error("Configuration is too deeply nested.");
    skip();
    const char = text[offset];
    if (char === '"' || char === "'") return string();
    if (char === "[" || char === "{") {
      offset++;
      const array: unknown[] = [];
      const map: Record<string, unknown> = Object.create(null);
      const end = char === "[" ? "]" : "}";
      skip();
      while (text[offset] !== end) {
        if (offset >= text.length) throw new Error("Incomplete configuration.");
        if (char === "[") array.push(value(depth + 1));
        else {
          const parts = keys();
          if (text[offset++] !== "=") throw new Error("Unsupported configuration.");
          assign(map, parts, value(depth + 1));
        }
        skip();
        if (text[offset] !== end && text[offset++] !== ",")
          throw new Error("Unsupported configuration.");
        skip();
      }
      offset++;
      return char === "[" ? array : map;
    }
    const match = /^[^\s,\]}#]+/u.exec(text.slice(offset));
    if (!match) throw new Error("Unsupported configuration.");
    offset += match[0].length;
    const token = match[0];
    if (token === "true" || token === "false") return token === "true";
    if (/^[+-]?\d[\d_.eE+-]*$/u.test(token)) return Number(token.replaceAll("_", ""));
    // Dates are irrelevant to import, but valid scalar config data.
    if (/^\d{4}-\d\d-\d\d/u.test(token)) return token;
    throw new Error("Unsupported configuration.");
  };
  while (offset < text.length) {
    skip();
    if (offset === text.length) break;
    if (text[offset] === "[") {
      offset++;
      const array = text[offset] === "[";
      if (array) offset++;
      const parts = keys();
      if (text[offset++] !== "]" || (array && text[offset++] !== "]"))
        throw new Error("Unsupported configuration.");
      table = root;
      for (const part of parts) {
        if (!Object.hasOwn(table, part)) table[part] = Object.create(null);
        const child = table[part];
        if (!child || typeof child !== "object" || Array.isArray(child))
          throw new Error("Unsupported configuration.");
        table = object(child);
      }
      // Unrelated array tables are ignored, never interpreted as server definitions.
      if (array) table = Object.create(null);
    } else {
      const parts = keys();
      if (text[offset++] !== "=") throw new Error("Unsupported configuration.");
      assign(table, parts, value());
    }
    skip(false);
    if (offset < text.length && text[offset++] !== "\n")
      throw new Error("Unsupported configuration.");
  }
  return root;
}

export function serverDefinition(
  name: string,
  input: unknown,
  source?: string,
): LocalImportServer | null {
  const config = object(input);
  const endpoint = config.httpUrl ?? config.url;
  const command = config.command;
  // These execution constraints have no equivalent in the current MCP registry.
  // Do not silently widen a source tool policy or install a command with a missing working directory.
  if (
    [
      "cwd",
      "includeTools",
      "excludeTools",
      "enabled_tools",
      "disabled_tools",
      "enabledTools",
      "disabledTools",
      "authProviderType",
    ].some((key) => config[key] !== undefined)
  )
    return null;
  if (
    config.args !== undefined &&
    (!Array.isArray(config.args) || !config.args.every((arg) => typeof arg === "string"))
  )
    return null;
  const args =
    Array.isArray(config.args) && config.args.every((v) => typeof v === "string")
      ? config.args
      : [];
  // Credentials in commands, arguments, URL queries or URL userinfo cannot be copied.
  // Unsupported definitions remain report-only; no partially broken command is installed.
  if (
    args.some(
      (arg) =>
        safeText(arg) !== arg ||
        /(?:token|secret|password|credential|api[-_]?key)|\$\{user_config\./iu.test(arg),
    )
  )
    return null;
  if (typeof command === "string" && (safeText(command) !== command || /[\n\r\0]/u.test(command)))
    return null;
  if (typeof endpoint === "string") {
    const parsed = McpRemoteEndpointSchema.safeParse(endpoint);
    if (!parsed.success || new URL(endpoint).search || safeText(endpoint) !== endpoint) return null;
  } else if (typeof command !== "string" || !command.trim()) return null;
  const envNames = new Set(Object.keys(object(config.env)));
  for (const key of Array.isArray(config.env_vars) ? config.env_vars : [])
    if (typeof key === "string") envNames.add(key);
  const headerEnv: LocalImportServer["headerEnv"] = {};
  const headerNames = new Set(Object.keys(object(config.headers ?? config.http_headers)));
  const bearer = config.bearer_token_env_var ?? config.bearerTokenEnvVar;
  if (typeof bearer === "string") {
    envNames.add(bearer);
    headerNames.add("Authorization");
    headerEnv.Authorization = { name: bearer, bearer: true };
  }
  for (const [header, name] of Object.entries(object(config.env_http_headers))) {
    if (typeof name !== "string") continue;
    envNames.add(name);
    headerNames.add(header);
    headerEnv[header] = { name, bearer: false };
  }
  const result = LocalImportServerSchema.safeParse({
    name: safeName(name),
    enabled: config.enabled !== false && config.disabled !== true,
    transport:
      typeof endpoint === "string"
        ? config.type === "sse" ||
          config.transport === "sse" ||
          (source === "gemini" && !config.httpUrl)
          ? "sse"
          : "streamable_http"
        : "stdio",
    ...(typeof endpoint === "string" ? { endpoint } : { command }),
    args,
    envNames: [...envNames].filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)).sort(),
    headerNames: [...headerNames].filter((key) => /^[A-Za-z0-9-]+$/u.test(key)).sort(),
    headerEnv,
  });
  return result.success ? result.data : null;
}
