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

function isParameter(value: unknown): value is HermesCompatParameter {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string" &&
    PARAMETER_KINDS.has(value[1])
  );
}

function checkHook(value: unknown): HermesCompatHook {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as HermesCompatHook).parameters) ||
    !(value as HermesCompatHook).parameters.every(isParameter)
  )
    throw new Error("Compatibility table is invalid");
  return value as HermesCompatHook;
}

/** The typed compatibility table; loading validates the shape, so a bad entry fails closed. */
export const HERMES_COMPAT: HermesCompatTable = (() => {
  const table = compat as unknown as HermesCompatTable;
  if (table?.format !== 1 || !table.entries || typeof table.entries !== "object")
    throw new Error("Compatibility table is invalid");
  for (const [tree, entry] of Object.entries(table.entries)) {
    if (
      !entry ||
      entry.tree !== tree ||
      typeof entry.version !== "string" ||
      typeof entry.commit !== "string" ||
      entry.commit.length !== 40 ||
      !entry.sources ||
      typeof entry.sources !== "object" ||
      Object.values(entry.sources).some(
        (digest) => typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest),
      ) ||
      !entry.agentInit ||
      typeof entry.agentInit.parameterCount !== "number" ||
      !Array.isArray(entry.agentInit.required) ||
      entry.agentInit.required.some((name) => typeof name !== "string") ||
      !entry.sourceGuard ||
      !Array.isArray(entry.sourceGuard.mustContain) ||
      !Array.isArray(entry.sourceGuard.mustNotContain) ||
      !entry.callbacks ||
      typeof entry.callbacks.setup_mcp_callback !== "string"
    )
      throw new Error("Compatibility table is invalid");
    checkHook(entry.sessionHook);
    checkHook(entry.toolsetHelper);
    checkHook(entry.acpAgentInit);
  }
  return table;
})();

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
