import { CliError } from "./transport.js";
export type Command =
  | { kind: "help" }
  | { kind: "pair"; code: string; json: boolean }
  | { kind: "bots" | "status"; json: boolean }
  | { kind: "stop"; taskId: string; json: boolean }
  | { kind: "send"; bot?: string; text?: string; file?: string; wait: boolean; json: boolean };
export const USAGE = [
  "ardur pair <pairing-code>",
  "ardur bots [--json]",
  'ardur send [<bot>] "<text>" [--wait] [--json]',
  "ardur send [<bot>] --file <path> [--wait] [--json]",
  "ardur stop <taskId> [--json]",
  "ardur status [--json]",
].join("\n");
const usage = () => {
  throw new CliError(USAGE, 3);
};
export function parseArgs(args: string[]): Command {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!)))
    return { kind: "help" };
  const [kind, ...rest] = args;
  const positions: string[] = [];
  let json = false;
  let wait = false;
  let file: string | undefined;
  let literal = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (literal) positions.push(arg);
    else if (arg === "--") literal = true;
    else if (arg === "--json" && !json) json = true;
    else if (arg === "--wait" && !wait && kind === "send") wait = true;
    else if (arg === "--file" && !file && kind === "send") {
      file = rest[++i];
      if (!file || file.startsWith("--")) usage();
    } else if (arg.startsWith("-")) usage();
    else positions.push(arg);
  }
  if (kind === "pair" && positions.length === 1) return { kind, code: positions[0]!, json };
  if ((kind === "bots" || kind === "status") && positions.length === 0) return { kind, json };
  if (kind === "stop" && positions.length === 1) return { kind, taskId: positions[0]!, json };
  if (kind === "send") {
    if (file && positions.length <= 1) return { kind, file, bot: positions[0], wait, json };
    if (!file && (positions.length === 1 || positions.length === 2))
      return {
        kind,
        bot: positions.length === 2 ? positions[0] : undefined,
        text: positions.at(-1),
        wait,
        json,
      };
  }
  return usage();
}
