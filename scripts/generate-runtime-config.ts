import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HERMES_CONFIG_ARTIFACT_VERSION,
  HERMES_MANAGED_PROFILE,
  HERMES_RUNTIME_V2_DEFAULTS,
  HERMES_SOURCE_REVISION,
  HermesRuntimeConfigV2DraftSchema,
  HermesRuntimeConfigV2Schema,
} from "../packages/contracts/src/runtime-config.js";
import { RUNTIME_CONFIG_FIELDS } from "../packages/contracts/src/runtime-config-editor.js";

const artifactPath = fileURLToPath(
  new URL("../packages/host-runtime/python/runtime_config_profile.json", import.meta.url),
);
const supportedPaths = Object.keys(RUNTIME_CONFIG_FIELDS);
if (
  supportedPaths.join("|") !==
  [
    "limits.maxProviderRequests",
    "limits.timeoutMs",
    "context.maxInputBytes",
    "context.overflow",
    "harness.agent.api_max_retries",
  ].join("|")
)
  throw new Error("Unsupported runtime configuration field vocabulary.");
if (!HermesRuntimeConfigV2Schema.safeParse(HERMES_RUNTIME_V2_DEFAULTS).success)
  throw new Error("The portable defaults do not satisfy the schema.");
const jsonSchema = HermesRuntimeConfigV2DraftSchema.toJSONSchema();
const portableKeywords = new Set([
  "$schema",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "const",
  "minimum",
  "maximum",
  "multipleOf",
  "enum",
]);
function assertPortableSchema(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertPortableSchema(item);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!portableKeywords.has(key))
        throw new Error(`Unsupported portable schema keyword: ${key}.`);
      if (key === "properties") {
        if (!item || typeof item !== "object" || Array.isArray(item))
          throw new Error("Invalid portable properties.");
        for (const child of Object.values(item)) assertPortableSchema(child);
      } else if (key !== "$schema") {
        if (key === "type" && !["object", "integer", "number", "string"].includes(String(item)))
          throw new Error("Unsupported portable type.");
        if (key === "additionalProperties" && item !== false)
          throw new Error("Portable objects must be strict.");
      }
    }
  }
}
assertPortableSchema(jsonSchema);
function leafPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") throw new Error("Invalid portable schema.");
  const node = value as { properties?: Record<string, unknown> };
  if (!node.properties) return [prefix];
  return Object.entries(node.properties).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}
if (
  leafPaths(jsonSchema)
    .filter((path) => path !== "version" && path !== "runtimeKind")
    .sort()
    .join("|") !== [...supportedPaths].sort().join("|")
)
  throw new Error("Portable schema fields differ from supported metadata.");
for (const [path, descriptor] of Object.entries(RUNTIME_CONFIG_FIELDS)) {
  let schemaField: unknown = jsonSchema;
  for (const segment of path.split(".")) {
    schemaField = (schemaField as { properties: Record<string, unknown> }).properties[segment];
  }
  const constraints = schemaField as Record<string, unknown>;
  if ("min" in descriptor) {
    if (
      constraints.type !== "integer" ||
      constraints.minimum !== descriptor.min ||
      constraints.maximum !== descriptor.max ||
      (constraints.multipleOf ?? 1) !== descriptor.step
    )
      throw new Error(`Portable constraints differ for ${path}.`);
    for (const candidate of [descriptor.min, descriptor.max]) {
      const raw = structuredClone(HERMES_RUNTIME_V2_DEFAULTS) as Record<string, unknown>;
      const segments = path.split(".");
      let object = raw;
      for (const segment of segments.slice(0, -1))
        object = object[segment] as Record<string, unknown>;
      object[segments.at(-1)!] = candidate;
      if (!HermesRuntimeConfigV2DraftSchema.safeParse(raw).success)
        throw new Error(`Unsupported portable bounds for ${path}.`);
    }
  } else if (
    constraints.type !== "string" ||
    JSON.stringify(constraints.enum) !== JSON.stringify(descriptor.values)
  ) {
    throw new Error(`Portable values differ for ${path}.`);
  }
}
const artifact = {
  format: 1,
  profile: HERMES_MANAGED_PROFILE,
  artifactVersion: HERMES_CONFIG_ARTIFACT_VERSION,
  sourceRevision: HERMES_SOURCE_REVISION,
  maxTextBytes: 16_384,
  maxDepth: 8,
  maxMembers: 128,
  fields: RUNTIME_CONFIG_FIELDS,
  defaults: HERMES_RUNTIME_V2_DEFAULTS,
  strictObjects: true,
  jsonSchema,
};
const output = `${JSON.stringify(artifact, null, 2).replace(/\[\n\s+"([^"]+)",\n\s+"([^"]+)"\n\s+\]/g, '["$1", "$2"]')}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(artifactPath, "utf8") !== output)
    throw new Error("Runtime configuration artifact is stale.");
} else {
  writeFileSync(artifactPath, output);
}
