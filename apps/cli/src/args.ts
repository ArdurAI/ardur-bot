import { CliError } from "./transport.js";
export type Command =
  | { kind: "help" }
  | {
      kind: "test";
      bot: string;
      prompt: string;
      expectContains: string;
      timeoutMs: number;
      transcript?: string;
      json: boolean;
    }
  | { kind: "pair"; code: string; json: boolean }
  | { kind: "bots" | "status"; json: boolean }
  | { kind: "stop"; taskId: string; json: boolean }
  | { kind: "runs-list"; cursor?: string; limit: number; json: boolean }
  | { kind: "runs-show"; runId: string; json: boolean }
  | { kind: "tasks-show"; taskId: string; json: boolean }
  | { kind: "wait"; runId: string; timeoutMs: number; json: boolean }
  | {
      kind: "send";
      bot?: string;
      text?: string;
      file?: string;
      wait: boolean;
      json: boolean;
      requestId?: string;
      timeoutMs: number;
    };
export const USAGE = [
  "ardur pair <pairing-code>",
  "ardur bots [--json]",
  'ardur send [<bot>] "<text>" [--wait] [--json]',
  "ardur send [<bot>] --file <path> [--wait] [--json]",
  'ardur test bot <name-or-id> --prompt "<text>" --expect-contains "<text>" [--timeout 180s] [--transcript <file>] [--json]',
  "ardur stop <taskId> [--json]",
  "ardur status [--json]",
  "ardur runs list [--cursor <run-id>] [--limit 50] [--json]",
  "ardur runs show <run-id> [--json]",
  "ardur tasks show <task-id> [--json]",
  "ardur wait --run <run-id> [--timeout 180s] [--json]",
  "ardur send [<bot>] <text> [--request-id <id>] [--wait] [--timeout 180s] [--json]",
].join("\n");
const usage = () => {
  throw new CliError(USAGE, 3);
};
export function parseArgs(args: string[]): Command {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!)))
    return { kind: "help" };
  if (args[0] === "test") return parseTestArgs(args.slice(1));
  if (["runs", "tasks", "wait"].includes(args[0]!)) return parseRecordArgs(args);
  const [kind, ...rest] = args;
  const positions: string[] = [];
  let json = false;
  let wait = false;
  let file: string | undefined;
  let requestId: string | undefined;
  let timeoutMs = 180_000;
  let timeoutSet = false;
  let literal = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (literal) positions.push(arg);
    else if (arg === "--") literal = true;
    else if (arg === "--json" && !json) json = true;
    else if (arg === "--wait" && !wait && kind === "send") wait = true;
    else if (arg === "--request-id" && kind === "send" && requestId === undefined) {
      requestId = rest[++i];
      if (
        !requestId ||
        requestId.length < 16 ||
        requestId.length > 128 ||
        requestId.startsWith("--")
      )
        usage();
    } else if (arg === "--timeout" && kind === "send" && !timeoutSet) {
      timeoutMs = parseDuration(rest[++i] ?? "");
      timeoutSet = true;
    } else if (arg === "--file" && !file && kind === "send") {
      file = rest[++i];
      if (!file || file.startsWith("--")) usage();
    } else if (arg.startsWith("-")) usage();
    else positions.push(arg);
  }
  if (kind === "pair" && positions.length === 1) return { kind, code: positions[0]!, json };
  if ((kind === "bots" || kind === "status") && positions.length === 0) return { kind, json };
  if (kind === "stop" && positions.length === 1) return { kind, taskId: positions[0]!, json };
  if (kind === "send") {
    if (file && positions.length <= 1)
      return { kind, file, bot: positions[0], wait, json, requestId, timeoutMs };
    if (!file && (positions.length === 1 || positions.length === 2))
      return {
        kind,
        bot: positions.length === 2 ? positions[0] : undefined,
        text: positions.at(-1),
        wait,
        json,
        requestId,
        timeoutMs,
      };
  }
  return usage();
}

function parseTestArgs(args: string[]): Extract<Command, { kind: "test" }> {
  const fail = (): never => {
    throw new CliError(USAGE, 3);
  };
  if (args[0] !== "bot" || !args[1] || args[1].startsWith("-")) return fail();
  const values = new Map<string, string>();
  let json = false;
  for (let i = 2; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--json" && !json) {
      json = true;
      continue;
    }
    if (
      !["--prompt", "--expect-contains", "--timeout", "--transcript"].includes(flag) ||
      values.has(flag)
    )
      return fail();
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) return fail();
    values.set(flag, value);
  }
  const prompt = values.get("--prompt");
  const expectContains = values.get("--expect-contains");
  if (!prompt?.trim() || prompt.length > 32_000 || !expectContains?.length) return fail();
  const timeout = values.get("--timeout") ?? "180s";
  const timeoutMs = parseDuration(timeout);
  if (values.has("--transcript") && !values.get("--transcript")) return fail();
  return {
    kind: "test",
    bot: args[1],
    prompt,
    expectContains,
    timeoutMs,
    transcript: values.get("--transcript"),
    json,
  };
}

export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value);
  if (!match) return usage();
  const duration = Number(match[1]) * (match[2] === "ms" ? 1 : match[2] === "m" ? 60_000 : 1000);
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 2_147_483_647) return usage();
  return duration;
}
function parseRecordArgs(args: string[]): Command {
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");
  if (args.filter((arg) => arg === "--json").length > 1) return usage();
  if (rest[0] === "runs" && rest[1] === "show" && rest.length === 3 && !rest[2]!.startsWith("-"))
    return { kind: "runs-show", runId: rest[2]!, json };
  if (rest[0] === "tasks" && rest[1] === "show" && rest.length === 3 && !rest[2]!.startsWith("-"))
    return { kind: "tasks-show", taskId: rest[2]!, json };
  const list = rest[0] === "runs" && rest[1] === "list";
  const wait = rest[0] === "wait";
  if (!list && !wait) return usage();
  const values = new Map<string, string>();
  for (let i = list ? 2 : 1; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (
      !(list ? ["--cursor", "--limit"] : ["--run", "--timeout"]).includes(flag) ||
      values.has(flag) ||
      !value ||
      value.startsWith("-")
    )
      return usage();
    values.set(flag, value);
  }
  if (list) {
    const limit = Number(values.get("--limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return usage();
    return { kind: "runs-list", limit, cursor: values.get("--cursor"), json };
  }
  if (!values.get("--run")) return usage();
  return {
    kind: "wait",
    runId: values.get("--run")!,
    timeoutMs: parseDuration(values.get("--timeout") ?? "180s"),
    json,
  };
}
