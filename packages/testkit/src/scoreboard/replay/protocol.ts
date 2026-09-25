import { canonicalSerialize, contentDigest } from "../manifest.js";
import { immutable } from "../tasks/catalog.js";

export type JsonPath = (string | number)[];
export type Variable =
  | { path: JsonPath; kind: "id"; name: string }
  | { path: JsonPath; kind: "timestamp"; name: string }
  | { path: JsonPath; kind: "current-time-line"; name: string }
  | { path: JsonPath; kind: "memory-reference-id" | "workspace-bot-id"; name: string };
export interface ReplayExchange {
  id: string;
  from: string;
  to: string;
  request: unknown;
  variables: Variable[];
  response: {
    status: number;
    headers: Record<string, string>;
    chunks: string[];
    end: "complete" | "disconnect";
  };
}
export interface ReplayFixture {
  version: 1;
  protocol: "openai-chat-sse" | "claude-stream-json" | "codex-jsonrpc";
  route: { provider: string; model: string; runtime: string; protocolVersion: string };
  initial: string;
  terminal: string[];
  exchanges: ReplayExchange[];
}

function valueAt(
  root: unknown,
  path: JsonPath,
): { parent: Record<string | number, unknown>; key: string | number } {
  if (
    !path.length ||
    path.some((part) => ["__proto__", "prototype", "constructor"].includes(String(part)))
  )
    throw new Error("Invalid variable path");
  let parent: unknown = root;
  for (const part of path.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, part))
      throw new Error("Variable path absent");
    parent = (parent as Record<string | number, unknown>)[part];
  }
  const key = path.at(-1)!;
  if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key))
    throw new Error("Variable path absent");
  return { parent: parent as Record<string | number, unknown>, key };
}

/** Only explicitly addressed IDs/timestamps vary. Object ordering varies; array order never does. */
export function normalizeRequest(
  request: unknown,
  variables: readonly Variable[],
  bindings: Map<string, string> = new Map(),
  allowPlaceholders = false,
): unknown {
  const copy: unknown = JSON.parse(canonicalSerialize(request));
  const paths = new Set<string>();
  for (const variable of variables) {
    if (variable.path.some((part) => ["tools", "parameters", "inputSchema"].includes(String(part))))
      throw new Error("Tool schemas cannot contain replay variables");
    if (
      variable.kind === "id" &&
      !["id", "requestId", "sessionId", "threadId", "runId", "tool_call_id"].includes(
        String(variable.path.at(-1)),
      )
    )
      throw new Error("Only ID fields may use ID normalization");
    const path = canonicalSerialize([variable.path, variable.kind]);
    if (paths.has(path)) throw new Error("Duplicate variable path");
    paths.add(path);
    if (!/^[a-z][a-z0-9-]*$/.test(variable.name)) throw new Error("Invalid variable name");
    const { parent, key } = valueAt(copy, variable.path);
    const actual = parent[key];
    const token = `<${variable.kind}:${variable.name}>`;
    if (
      allowPlaceholders &&
      (actual === token ||
        (["current-time-line", "memory-reference-id", "workspace-bot-id"].includes(variable.kind) &&
          typeof actual === "string" &&
          actual.split(token).length === 2))
    )
      continue;
    if (variable.kind === "id") {
      if (
        (typeof actual !== "string" || !/^[\w-]{1,128}$/.test(actual)) &&
        (typeof actual !== "number" || !Number.isSafeInteger(actual) || actual < 0)
      )
        throw new Error("Invalid declared ID");
      const value = String(actual);
      const prior = bindings.get(variable.name);
      if (prior !== undefined && prior !== value) throw new Error("Replay ID binding changed");
      bindings.set(variable.name, value);
      parent[key] = token;
    } else if (variable.kind === "timestamp") {
      if (
        typeof actual !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(actual) ||
        !Number.isFinite(Date.parse(actual))
      )
        throw new Error("Invalid declared timestamp");
      parent[key] = token;
    } else if (variable.kind === "memory-reference-id" || variable.kind === "workspace-bot-id") {
      if (typeof actual !== "string") throw new Error("Embedded ID must be text");
      const pattern =
        variable.kind === "memory-reference-id"
          ? /(?<=\[ardur-memory:)[a-z0-9]{25}(?=:\d+\])/g
          : /(?<=Your Team Computer home is bots\/)[a-z0-9]{25}(?=\. Relative file paths)/g;
      const matches = actual.match(pattern);
      if (matches?.length !== 1) throw new Error("Expected exactly one declared embedded ID");
      const prior = bindings.get(variable.name);
      if (prior !== undefined && prior !== matches[0]) throw new Error("Replay ID binding changed");
      bindings.set(variable.name, matches[0]!);
      parent[key] = actual.replace(pattern, token);
    } else {
      if (typeof actual !== "string") throw new Error("Current time must be text");
      // Preserve the line's position and every surrounding byte, including tool descriptions.
      const pattern =
        /Current date and time: (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \(UTC\)\./g;
      const matches = actual.match(pattern);
      if (matches?.length !== 1) throw new Error("Expected exactly one current-time line");
      const timestamp = matches[0]!.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/)![0];
      if (!Number.isFinite(Date.parse(timestamp)))
        throw new Error("Invalid current-time timestamp");
      parent[key] = actual.replace(pattern, token);
    }
  }
  return copy;
}

export function countAssembledRequest(request: unknown) {
  const serialized = canonicalSerialize(request);
  const bytes = Buffer.byteLength(serialized, "utf8");
  return {
    requestHash: contentDigest(request),
    serializedBytes: bytes,
    tokens: Math.ceil(bytes / 4),
    exactness: "estimate" as const,
    implementation: "canonical-json-utf8-div4-v1",
    routeValidation: "unvalidated-estimator" as const,
  };
}

/** Matching advances synchronously before delay/IO, so concurrent requests cannot reuse a step. */
export class StrictReplay {
  readonly fixture: ReplayFixture;
  readonly sha256: string;
  readonly requests: ReturnType<typeof countAssembledRequest>[] = [];
  private state: string;
  private bindings = new Map<string, string>();
  private failure: Error | null = null;
  private consumed = 0;

  constructor(fixture: ReplayFixture) {
    if (
      fixture.version !== 1 ||
      !["openai-chat-sse", "claude-stream-json", "codex-jsonrpc"].includes(fixture.protocol)
    )
      throw new Error("Unsupported replay schema");
    this.fixture = immutable(JSON.parse(canonicalSerialize(fixture)) as ReplayFixture);
    this.sha256 = contentDigest(this.fixture);
    this.state = fixture.initial;
    const ids = new Set<string>();
    for (const step of this.fixture.exchanges) {
      if (ids.has(step.id)) throw new Error("Duplicate replay exchange");
      ids.add(step.id);
      normalizeRequest(step.request, step.variables, new Map(), true);
    }
  }

  accept(request: unknown): ReplayExchange {
    if (this.failure) throw this.failure;
    this.requests.push(countAssembledRequest(request));
    const matches = this.fixture.exchanges.filter((step) => {
      if (step.from !== this.state) return false;
      try {
        return (
          canonicalSerialize(normalizeRequest(request, step.variables, new Map(this.bindings))) ===
          canonicalSerialize(normalizeRequest(step.request, step.variables, new Map(), true))
        );
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) {
      this.failure = new Error(
        matches.length ? "Ambiguous replay branch" : "Undeclared replay request mismatch",
      );
      throw this.failure;
    }
    const selected = matches[0]!;
    normalizeRequest(request, selected.variables, this.bindings);
    this.state = selected.to;
    this.consumed++;
    return selected;
  }

  assertComplete() {
    if (this.failure) throw this.failure;
    if (!this.consumed || !this.fixture.terminal.includes(this.state))
      throw new Error("Replay fixture incomplete");
  }
}

export const REPLAY_SCHEDULES = immutable({
  "zero-service-delay": { firstChunkMs: 0, chunkMs: 0, toolMs: 0 },
  "fixed-delay": { firstChunkMs: 40, chunkMs: 5, toolMs: 20 },
});
export type ReplayTiming = keyof typeof REPLAY_SCHEDULES;
