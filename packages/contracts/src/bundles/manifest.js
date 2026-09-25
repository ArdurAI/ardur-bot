import path from "node:path";
import { bundlePath } from "./files.js";
export function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The manifest contains an invalid object.");
  const result = value;
  if (Object.keys(result).some((key) => ["__proto__", "prototype", "constructor"].includes(key)))
    throw new Error("The manifest contains an unsafe key.");
  return result;
}
export function manifestText(value, max = 4096) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 && !["\t", "\n", "\r"].includes(character),
    )
  )
    throw new Error("The manifest is missing a required field or contains invalid text.");
  return value;
}
function strings(value, max = 64) {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("The manifest contains an invalid list.");
  return value.map((entry) => {
    if (entry === "") return "";
    return manifestText(entry);
  });
}
function environment(value) {
  const entries = Object.entries(record(value ?? {}));
  if (entries.length > 64) throw new Error("The manifest has too many environment variables.");
  return Object.fromEntries(
    entries.map(([key, item]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        throw new Error("The manifest has an invalid environment variable name.");
      return [key, item === "" ? "" : manifestText(item)];
    }),
  );
}
function launch(value, partial = false) {
  const data = record(value);
  return {
    ...(!partial || data.command !== undefined ? { command: manifestText(data.command, 512) } : {}),
    ...(!partial || data.args !== undefined ? { args: strings(data.args ?? []) } : {}),
    ...(!partial || data.env !== undefined ? { env: environment(data.env) } : {}),
  };
}
function validateValue(field, value) {
  if (field.multiple) {
    if (!["directory", "file", "string"].includes(field.type))
      throw new Error("Only text and paths can have multiple values.");
    return strings(value);
  }
  if (field.type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (field.min !== undefined && value < field.min) ||
      (field.max !== undefined && value > field.max)
    )
      throw new Error("Enter a number within the allowed range.");
    return value;
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new Error("Choose a boolean value.");
    return value;
  }
  if (value === "") return "";
  return manifestText(value, 16_384);
}
function userFields(value) {
  const entries = Object.entries(record(value ?? {}));
  if (entries.length > 64) throw new Error("The manifest has too many configuration fields.");
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        throw new Error("The manifest has an invalid configuration key.");
      const data = record(value);
      if (!["string", "number", "boolean", "directory", "file"].includes(String(data.type)))
        throw new Error("The manifest has an unsupported configuration type.");
      const field = {
        type: data.type,
        title: manifestText(data.title, 200),
        description: data.description === "" ? "" : manifestText(data.description, 2000),
      };
      for (const flag of ["required", "multiple", "sensitive"]) {
        if (data[flag] === undefined) continue;
        if (typeof data[flag] !== "boolean")
          throw new Error("The manifest contains an invalid field flag.");
        field[flag] = data[flag];
      }
      for (const bound of ["min", "max"]) {
        if (data[bound] === undefined) continue;
        if (typeof data[bound] !== "number" || !Number.isFinite(data[bound]))
          throw new Error("The manifest contains an invalid numeric limit.");
        field[bound] = data[bound];
      }
      if (field.min !== undefined && field.max !== undefined && field.min > field.max)
        throw new Error("The manifest contains an invalid numeric range.");
      if (data.default !== undefined) field.default = validateValue(field, data.default);
      return [key, field];
    }),
  );
}
/** Fields consumed from the official MCPB 0.1–0.4 schemas; metadata is never executable. */
export function parseMcpbManifest(value, platform = process.platform) {
  const data = record(value);
  const version = data.manifest_version ?? data.dxt_version;
  if (
    !["0.1", "0.2", "0.3", "0.4"].includes(String(version)) ||
    (data.manifest_version !== undefined &&
      data.dxt_version !== undefined &&
      data.manifest_version !== data.dxt_version)
  )
    throw new Error("This bundle uses an unsupported manifest version.");
  const server = record(data.server);
  if (
    !["node", "python", "binary", ...(version === "0.4" ? ["uv"] : [])].includes(
      String(server.type),
    )
  )
    throw new Error("This bundle uses an unsupported runtime.");
  const config = record(server.mcp_config);
  const compatibility = record(data.compatibility ?? {});
  const platforms =
    compatibility.platforms === undefined ? undefined : strings(compatibility.platforms, 3);
  if (platforms?.some((entry) => !["darwin", "win32", "linux"].includes(entry)))
    throw new Error("The manifest has an invalid platform.");
  if (platforms && !platforms.includes(platform))
    throw new Error("This bundle does not support this computer.");
  const runtimes = Object.fromEntries(
    Object.entries(record(compatibility.runtimes ?? {})).map(([key, value]) => [
      key,
      manifestText(value, 200),
    ]),
  );
  const overrides = Object.fromEntries(
    Object.entries(record(config.platform_overrides ?? {})).map(([key, value]) => [
      key,
      launch(value, true),
    ]),
  );
  const tools = data.tools === undefined ? [] : data.tools;
  if (!Array.isArray(tools) || tools.length > 2000)
    throw new Error("The manifest has an invalid tools list.");
  return {
    manifest_version: String(version),
    name: manifestText(data.name, 128),
    ...(data.display_name !== undefined
      ? { display_name: manifestText(data.display_name, 200) }
      : {}),
    version: manifestText(data.version, 100),
    description: manifestText(data.description, 2000),
    author: { name: manifestText(record(data.author).name, 200) },
    ...(data.icon !== undefined && typeof data.icon === "string" && !data.icon.includes(":")
      ? { icon: bundlePath(data.icon) }
      : {}),
    server: {
      type: server.type,
      entry_point: bundlePath(manifestText(server.entry_point)),
      mcp_config: { ...launch(config), platform_overrides: overrides },
    },
    compatibility: { platforms, runtimes },
    user_config: userFields(data.user_config),
    tools: tools.map((tool) => {
      const entry = record(tool);
      return {
        name: manifestText(entry.name, 200),
        ...(entry.description === undefined
          ? {}
          : { description: manifestText(entry.description, 8000) }),
      };
    }),
  };
}
export function validateUserConfig(manifest, value) {
  const supplied = record(value);
  if (Object.keys(supplied).some((key) => !Object.hasOwn(manifest.user_config, key)))
    throw new Error("Remove unknown configuration fields.");
  return Object.fromEntries(
    Object.entries(manifest.user_config).flatMap(([key, field]) => {
      const value = supplied[key] ?? field.default;
      if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
        if (field.required) throw new Error("Complete the required configuration fields.");
        return value === undefined ? [] : [[key, validateValue(field, value)]];
      }
      return [[key, validateValue(field, value)]];
    }),
  );
}
export function resolveMcpbLaunch(manifest, input) {
  const defaults = Object.fromEntries(
    Object.entries(manifest.user_config).flatMap(([key, field]) => {
      if (
        field.default === undefined ||
        (Object.hasOwn(input.config, key) &&
          JSON.stringify(input.config[key]) !== JSON.stringify(field.default))
      )
        return [];
      const expand = (value) =>
        value.replace(/\$\{([^}]+)\}/g, (_match, name) => {
          if (!Object.hasOwn(input.variables, name))
            throw new Error("The configuration default uses an unsupported variable.");
          return input.variables[name];
        });
      const value = field.default;
      return [
        [
          key,
          Array.isArray(value)
            ? value.map(expand)
            : typeof value === "string"
              ? expand(value)
              : value,
        ],
      ];
    }),
  );
  const config = validateUserConfig(manifest, { ...input.config, ...defaults });
  const vars = {
    ...input.variables,
    __dirname: input.directory,
    pathSeparator: input.platform === "win32" ? "\\" : "/",
    "/": input.platform === "win32" ? "\\" : "/",
  };
  for (const [key, value] of Object.entries(config)) vars[`user_config.${key}`] = value;
  const substitute = (text) =>
    text.replace(/\$\{([^}]+)\}/g, (_match, key) => {
      if (!Object.hasOwn(vars, key))
        throw new Error("Complete configuration before starting this extension.");
      const value = vars[key];
      if (Array.isArray(value)) throw new Error("Multiple values must use a separate argument.");
      return String(value);
    });
  const base = manifest.server.mcp_config;
  const override = base.platform_overrides[input.platform];
  let command = substitute(override?.command ?? base.command);
  const paths = input.platform === "win32" ? path.win32 : path.posix;
  if (manifest.server.type === "binary" && !paths.isAbsolute(command)) {
    command = paths.join(input.directory, bundlePath(command));
    if (input.platform === "win32" && !command.toLowerCase().endsWith(".exe")) command += ".exe";
  }
  const args = (override?.args ?? base.args).flatMap((arg) => {
    const match = arg.match(/^\$\{([^}]+)\}$/);
    const value = match ? vars[match[1]] : undefined;
    return Array.isArray(value) ? value.map(substitute) : [substitute(arg)];
  });
  const env = Object.fromEntries(
    Object.entries({ ...base.env, ...override?.env }).map(([key, value]) => [
      key,
      substitute(value),
    ]),
  );
  return { command, args, env, cwd: input.directory };
}
/** Credentials never enter the renderer's initial form state. */
export function configurationFields(manifest, values) {
  return Object.entries(manifest.user_config).map(([key, field]) => {
    const { default: initial, ...definition } = field;
    return {
      key,
      ...definition,
      configured: Object.hasOwn(values, key),
      ...(!field.sensitive ? { value: values[key] ?? initial } : {}),
    };
  });
}
