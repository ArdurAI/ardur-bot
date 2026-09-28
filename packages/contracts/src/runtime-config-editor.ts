import type {
  HermesRuntimeConfigV2Draft,
  RuntimeConfigIssue,
  RuntimeConfigIssueCode,
} from "./runtime-config.js";
import { HermesRuntimeConfigV2DraftSchema } from "./runtime-config.js";

export const RUNTIME_CONFIG_TEXT_BYTES = 16 * 1024;
export const RUNTIME_CONFIG_MAX_DEPTH = 8;
export const RUNTIME_CONFIG_MAX_MEMBERS = 128;
export const RUNTIME_CONFIG_MAX_ISSUES = 20;

export const RUNTIME_CONFIG_FIELDS = {
  "limits.maxProviderRequests": { min: 1, max: 64, step: 1, default: 16 },
  "limits.timeoutMs": { min: 1_000, max: 600_000, step: 1_000, default: 180_000 },
  "context.maxInputBytes": { min: 4_096, max: 65_536, step: 1_024, default: 16_384 },
  "context.overflow": { values: ["trim", "stop"], default: "trim" },
  "harness.agent.api_max_retries": { min: 1, max: 3, step: 1, default: 1 },
} as const;

const supported = new Map<string, readonly string[]>([
  ["", ["version", "runtimeKind", "limits", "context", "harness"]],
  ["limits", ["maxProviderRequests", "timeoutMs"]],
  ["context", ["maxInputBytes", "overflow"]],
  ["harness", ["agent"]],
  ["harness.agent", ["api_max_retries"]],
]);
const classifications = new Map<string, RuntimeConfigIssueCode>([
  ["model", "managed-model"],
  ["models", "managed-model"],
  ["effort", "managed-model"],
  ["thinking", "managed-model"],
  ["reasoning_effort", "managed-model"],
  ["model_overrides", "managed-model"],
  ["provider", "managed-connection"],
  ["providers", "managed-connection"],
  ["custom_providers", "managed-connection"],
  ["credentials", "managed-connection"],
  ["credential", "managed-connection"],
  ["api_key", "managed-connection"],
  ["headers", "managed-connection"],
  ["base_url", "managed-connection"],
  ["endpoint", "managed-connection"],
  ["fallback_providers", "managed-connection"],
  ["providerBackupModel", "managed-connection"],
  ["auxiliaryModel", "managed-connection"],
  ["imageModel", "managed-connection"],
  ["tools", "managed-tools"],
  ["toolsets", "managed-tools"],
  ["disabled_toolsets", "managed-tools"],
  ["mcp_servers", "managed-tools"],
  ["mcpServers", "managed-tools"],
  ["integrations", "managed-tools"],
  ["skills", "managed-tools"],
  ["plugins", "managed-tools"],
  ["packages", "forbidden-code-loading"],
  ["extensions", "forbidden-code-loading"],
  ["engine", "forbidden-code-loading"],
  ["allow_lazy_installs", "forbidden-code-loading"],
  ["project_discovery", "forbidden-code-loading"],
  ["hooks", "managed-policy"],
  ["hooks_auto_accept", "managed-policy"],
  ["approvals", "managed-policy"],
  ["approval", "managed-policy"],
  ["permissions", "managed-policy"],
  ["network", "managed-policy"],
  ["proxy", "managed-policy"],
  ["shell", "managed-policy"],
  ["command_allowlist", "managed-policy"],
  ["path", "forbidden-path"],
  ["home", "forbidden-path"],
  ["workspace", "forbidden-path"],
  ["env", "forbidden-path"],
  ["environment", "forbidden-path"],
  ["session_path", "forbidden-path"],
  ["memory", "native-learning-unavailable"],
  ["learning", "native-learning-unavailable"],
  ["autoRefine", "native-learning-unavailable"],
  ["background_review", "native-learning-unavailable"],
  ["curator", "native-learning-unavailable"],
  ["user_profile_enabled", "native-learning-unavailable"],
  ["delegation", "native-children-unavailable"],
  ["children", "native-children-unavailable"],
  ["run_subagent", "native-children-unavailable"],
  ["subagents", "native-children-unavailable"],
  ["compression", "native-compression-unavailable"],
  ["compaction", "native-compression-unavailable"],
  ["threshold", "native-compression-unavailable"],
  ["pruning", "native-compression-unavailable"],
  ["proactive_pruning", "native-compression-unavailable"],
]);
const dangerous = new Set(["__proto__", "prototype", "constructor"]);
const safePart = (part: string) =>
  /^[A-Za-z][A-Za-z0-9_]*$/.test(part) &&
  Array.from(supported.values()).some((keys) => keys.includes(part));
const safePath = (path: readonly string[]) => path.filter(safePart).join(".");
const issue = (
  code: RuntimeConfigIssueCode,
  path: readonly string[],
  range?: { start: number; end: number },
): RuntimeConfigIssue => ({
  code,
  path: safePath(path),
  reasonId: code,
  ...(range ? { range } : {}),
});

class JsonScanError extends Error {
  constructor(
    readonly code: RuntimeConfigIssueCode,
    readonly start: number,
    readonly end: number,
  ) {
    super(code);
  }
}

/** Bounded lexical pass: JSON.parse alone discards duplicate object keys. */
function scanJson(text: string): RuntimeConfigIssue[] {
  let pos = 0;
  let members = 0;
  const found: RuntimeConfigIssue[] = [];
  const ws = () => {
    while (/\s/.test(text[pos] ?? "") && pos < text.length) pos++;
  };
  const fail = (code: RuntimeConfigIssueCode, start = pos): never => {
    throw new JsonScanError(code, start, Math.max(start + 1, pos));
  };
  const string = (): { value: string; start: number; end: number } => {
    const start = pos;
    if (text[pos++] !== '"') fail("invalid-json", start);
    while (pos < text.length) {
      const char = text[pos++];
      if (char === '"') {
        const raw = text.slice(start, pos);
        try {
          return { value: JSON.parse(raw) as string, start, end: pos };
        } catch {
          fail("invalid-json", start);
        }
      }
      if (char === "\\") pos++;
      else if (char && char.charCodeAt(0) < 32) fail("invalid-json", start);
    }
    return fail("invalid-json", start);
  };
  const value = (depth: number, path: string[]): void => {
    ws();
    if (depth > RUNTIME_CONFIG_MAX_DEPTH) fail("too-deep");
    if (text[pos] === "{") {
      pos++;
      ws();
      const seen = new Set<string>();
      if (text[pos] === "}") {
        pos++;
        return;
      }
      while (pos < text.length) {
        ws();
        const key = string();
        members++;
        if (members > RUNTIME_CONFIG_MAX_MEMBERS) fail("too-many-members", key.start);
        if (dangerous.has(key.value))
          found.push(issue("prototype-key", path, { start: key.start, end: key.end }));
        if (seen.has(key.value))
          found.push(
            issue("duplicate-key", [...path, key.value], { start: key.start, end: key.end }),
          );
        seen.add(key.value);
        ws();
        if (text[pos++] !== ":") fail("invalid-json");
        value(depth + 1, [...path, key.value]);
        ws();
        if (text[pos] === "}") {
          pos++;
          return;
        }
        if (text[pos++] !== ",") fail("invalid-json");
      }
      fail("invalid-json");
    }
    if (text[pos] === "[") {
      pos++;
      ws();
      if (text[pos] === "]") {
        pos++;
        return;
      }
      while (pos < text.length) {
        value(depth + 1, path);
        ws();
        if (text[pos] === "]") {
          pos++;
          return;
        }
        if (text[pos++] !== ",") fail("invalid-json");
      }
      fail("invalid-json");
    }
    if (text[pos] === '"') {
      string();
      return;
    }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      text.slice(pos),
    );
    if (!match) {
      fail("invalid-json");
      return;
    }
    pos += match[0].length;
  };
  try {
    value(0, []);
    ws();
    if (pos !== text.length) fail("invalid-json");
  } catch (error) {
    if (error instanceof JsonScanError)
      found.push(issue(error.code, [], { start: error.start, end: error.end }));
    else throw error;
  }
  return found.slice(0, RUNTIME_CONFIG_MAX_ISSUES);
}

export type RuntimeConfigTextResult =
  | { success: true; document: HermesRuntimeConfigV2Draft; issues: [] }
  | { success: false; issues: RuntimeConfigIssue[] };

export function parseRuntimeConfigText(text: string): RuntimeConfigTextResult {
  if (new TextEncoder().encode(text).length > RUNTIME_CONFIG_TEXT_BYTES)
    return { success: false, issues: [issue("document-too-large", [])] };
  const lexical = scanJson(text);
  if (lexical.length) return { success: false, issues: lexical };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { success: false, issues: [issue("invalid-json", [])] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { success: false, issues: [issue("invalid-json", [])] };
  const root = raw as Record<string, unknown>;
  const found: RuntimeConfigIssue[] = [];
  if (root.version !== 2) found.push(issue("unsupported-version", ["version"]));
  if (root.runtimeKind !== "hermes") found.push(issue("unsupported-runtime", ["runtimeKind"]));
  const visit = (object: Record<string, unknown>, path: string[]) => {
    for (const [key, value] of Object.entries(object)) {
      if (found.length >= RUNTIME_CONFIG_MAX_ISSUES) return;
      const child = [...path, key];
      if (!supported.get(path.join("."))?.includes(key)) {
        found.push(issue(classifications.get(key) ?? "unknown-field", child));
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        visit(value as Record<string, unknown>, child);
      }
    }
  };
  visit(root, []);
  if (found.length) return { success: false, issues: found };
  const parsed = HermesRuntimeConfigV2DraftSchema.safeParse(root);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues
        .slice(0, RUNTIME_CONFIG_MAX_ISSUES)
        .map((item) => issue("out-of-range", item.path.map(String))),
    };
  }
  return { success: true, document: parsed.data, issues: [] };
}
