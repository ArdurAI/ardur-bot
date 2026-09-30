import compat from "../../python/hermes_compat.json" with { type: "json" };
import sourceHashes from "../../python/hermes_sources.json" with { type: "json" };
import { HERMES_SOURCE_PIN, HERMES_SOURCE_TREE } from "./hermes-install.js";

/** One hooked parameter as `[name, inspect.Parameter.kind name]`. */
export type HermesCompatParameter = [name: string, kind: string];

export interface HermesCompatHook {
  parameters: HermesCompatParameter[];
}

export interface HermesCompatAgentInit {
  parameterCount: number;
  required: string[];
}

export interface HermesCompatSourceGuard {
  mustContain: string[];
  mustNotContain: string[];
}

/** The MCP-attach callback name, keyed by the name the old pin used. */
export interface HermesCompatCallbacks {
  setup_mcp_callback: string;
}

/** Exact toolsets the constructed agent must carry; entries without it keep the source-guard-only check. */
export interface HermesCompatConstructedToolsets {
  enabled: string[];
  disabled: string[];
}

/** Reviewed qualification of one Hermes source tree. Keyed by git tree id. */
export interface HermesCompatEntry {
  version: string;
  commit: string;
  tree: string;
  sources: Record<string, string>;
  sessionHook: HermesCompatHook;
  toolsetHelper: HermesCompatHook;
  acpAgentInit: HermesCompatHook;
  agentInit: HermesCompatAgentInit;
  sourceGuard: HermesCompatSourceGuard;
  callbacks: HermesCompatCallbacks;
  constructedToolsets?: HermesCompatConstructedToolsets;
}

export interface HermesCompatTable {
  format: number;
  entries: Record<string, HermesCompatEntry>;
}

const PARAMETER_KINDS = new Set([
  "POSITIONAL_ONLY",
  "POSITIONAL_OR_KEYWORD",
  "VAR_POSITIONAL",
  "KEYWORD_ONLY",
  "VAR_KEYWORD",
]);

const ENTRY_FIELDS = new Set([
  "version",
  "commit",
  "tree",
  "sources",
  "sessionHook",
  "toolsetHelper",
  "acpAgentInit",
  "agentInit",
  "sourceGuard",
  "callbacks",
]);
const OPTIONAL_ENTRY_FIELDS = new Set(["constructedToolsets"]);

function sameKeys(value: object, expected: Set<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function isStringList(value: unknown, nonEmpty = false): value is string[] {
  return (
    Array.isArray(value) &&
    (!nonEmpty || value.length > 0) &&
    value.every((item) => typeof item === "string")
  );
}

function isParameter(value: unknown): value is HermesCompatParameter {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string" &&
    PARAMETER_KINDS.has(value[1])
  );
}

function checkHook(value: unknown): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !sameKeys(value, new Set(["parameters"]))
  )
    throw new Error("Compatibility table is invalid");
  const parameters = (value as HermesCompatHook).parameters;
  if (!Array.isArray(parameters) || parameters.length === 0 || !parameters.every(isParameter))
    throw new Error("Compatibility table is invalid");
}

/**
 * Validate the reviewed per-tree compatibility table, refusing any defect.
 *
 * Every entry must carry exactly the reviewed fields; sources must be
 * non-empty and cover the same reviewed files in every entry; and any
 * missing, extra or malformed field refuses the whole table. This must stay
 * in step with `validate_compat` in `python/hermes_launcher.py`; the shared
 * fixtures in `python/tests/compat_fixtures.json` prove both sides agree.
 */
export function assertCompatTableValid(table: unknown): HermesCompatTable {
  if (
    !table ||
    typeof table !== "object" ||
    Array.isArray(table) ||
    !sameKeys(table, new Set(["format", "entries"]))
  )
    throw new Error("Compatibility table is invalid");
  const compat = table as HermesCompatTable;
  if (compat.format !== 1 || !compat.entries || typeof compat.entries !== "object")
    throw new Error("Compatibility table is invalid");
  const entries = Object.entries(compat.entries);
  if (entries.length === 0) throw new Error("Compatibility table is invalid");
  let sourcePaths: string[] | undefined;
  for (const [tree, entry] of entries) {
    if (!isHex(tree, 40) || !entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Compatibility table is invalid");
    const keys = new Set([...ENTRY_FIELDS, ...OPTIONAL_ENTRY_FIELDS]);
    if (!sameKeys(entry, keys) && !sameKeys(entry, ENTRY_FIELDS))
      throw new Error("Compatibility table is invalid");
    if (
      typeof entry.version !== "string" ||
      entry.version.length === 0 ||
      entry.tree !== tree ||
      !isHex(entry.commit, 40)
    )
      throw new Error("Compatibility table is invalid");
    if (
      !entry.sources ||
      typeof entry.sources !== "object" ||
      Array.isArray(entry.sources) ||
      Object.keys(entry.sources).length === 0 ||
      Object.entries(entry.sources).some(
        ([name, digest]) => typeof name !== "string" || !isHex(digest, 64),
      )
    )
      throw new Error("Compatibility table is invalid");
    const paths = Object.keys(entry.sources).sort();
    if (sourcePaths && paths.join() !== sourcePaths.join())
      throw new Error("Compatibility table is invalid");
    sourcePaths = paths;
    checkHook(entry.sessionHook);
    checkHook(entry.toolsetHelper);
    checkHook(entry.acpAgentInit);
    if (
      entry.sessionHook.parameters[0]?.[0] !== "self" ||
      entry.acpAgentInit.parameters[0]?.[0] !== "self"
    )
      throw new Error("Compatibility table is invalid");
    if (
      !entry.agentInit ||
      typeof entry.agentInit !== "object" ||
      Array.isArray(entry.agentInit) ||
      !sameKeys(entry.agentInit, new Set(["parameterCount", "required"])) ||
      typeof entry.agentInit.parameterCount !== "number" ||
      !Number.isInteger(entry.agentInit.parameterCount) ||
      entry.agentInit.parameterCount < 0 ||
      !isStringList(entry.agentInit.required, true) ||
      entry.agentInit.parameterCount < entry.agentInit.required.length
    )
      throw new Error("Compatibility table is invalid");
    if (
      !entry.sourceGuard ||
      typeof entry.sourceGuard !== "object" ||
      Array.isArray(entry.sourceGuard) ||
      !sameKeys(entry.sourceGuard, new Set(["mustContain", "mustNotContain"])) ||
      !isStringList(entry.sourceGuard.mustContain) ||
      !isStringList(entry.sourceGuard.mustNotContain) ||
      entry.sourceGuard.mustContain.length + entry.sourceGuard.mustNotContain.length === 0
    )
      throw new Error("Compatibility table is invalid");
    if (
      !entry.callbacks ||
      typeof entry.callbacks !== "object" ||
      Array.isArray(entry.callbacks) ||
      !sameKeys(entry.callbacks, new Set(["setup_mcp_callback"])) ||
      typeof entry.callbacks.setup_mcp_callback !== "string" ||
      entry.callbacks.setup_mcp_callback.length === 0
    )
      throw new Error("Compatibility table is invalid");
    if ("constructedToolsets" in entry) {
      const constructed = entry.constructedToolsets;
      if (
        !constructed ||
        typeof constructed !== "object" ||
        Array.isArray(constructed) ||
        !sameKeys(constructed, new Set(["enabled", "disabled"])) ||
        !isStringList(constructed.enabled, true) ||
        !isStringList(constructed.disabled, true)
      )
        throw new Error("Compatibility table is invalid");
    }
  }
  return compat;
}

/** The typed compatibility table; loading validates the shape, so a bad entry fails closed. */
export const HERMES_COMPAT: HermesCompatTable = assertCompatTableValid(compat);

/** The entry the pinned install must resolve to; absent entries are refused by both sides. */
export const HERMES_COMPAT_PINNED: HermesCompatEntry | undefined =
  HERMES_COMPAT.entries[HERMES_SOURCE_TREE];

/** Every launcher-checked source path stays identical across table entries. */
export function hermesCompatSourcePaths(): string[] {
  const paths = new Set<string>();
  for (const entry of Object.values(HERMES_COMPAT.entries)) {
    for (const name of Object.keys(entry.sources)) paths.add(name);
  }
  return [...paths].sort();
}

/** The current pin's launcher-checked hashes, kept equal to the table entry. */
export function hermesCompatPinnedSources(): Record<string, string> {
  const pinned = HERMES_COMPAT_PINNED;
  if (!pinned) throw new Error("Compatibility table is invalid");
  return pinned.sources;
}

/** The table entry must describe exactly the pinned install the TypeScript side checks. */
export function assertHermesCompatInStep(): void {
  const pinned = HERMES_COMPAT_PINNED;
  if (!pinned || pinned.commit !== HERMES_SOURCE_PIN)
    throw new Error("Compatibility table is out of step with the source pin.");
  if (JSON.stringify(hermesCompatPinnedSources()) !== JSON.stringify(sourceHashes))
    throw new Error("Compatibility table is out of step with the source hashes.");
}
