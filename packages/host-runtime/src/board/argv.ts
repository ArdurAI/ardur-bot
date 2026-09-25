import { BoardError, BoardItemIdSchema } from "@ardurbot/contracts/board";

const fields = [
  "--title",
  "--description",
  "--acceptance",
  "--type",
  "--priority",
  "--assignee",
  "--parent",
  "--due",
  "--defer",
  "--estimate",
  "--external-ref",
];
const filters = ["--type", "--label", "--assignee", "--parent", "--status", "--limit"];
const commands: Record<string, { values?: string[]; flags?: string[]; min: number; max: number }> =
  {
    ready: { values: filters.filter((s) => s !== "--status"), flags: ["--claim"], min: 0, max: 0 },
    blocked: { values: ["--parent"], min: 0, max: 0 },
    list: { values: filters, flags: ["--all"], min: 0, max: 0 },
    show: { flags: ["--include-comments", "--include-dependents"], min: 1, max: 1 },
    create: { values: [...fields, "--labels"], min: 0, max: 0 },
    update: {
      values: [...fields, "--status", "--set-labels", "--set-metadata"],
      flags: ["--claim"],
      min: 1,
      max: 1,
    },
    close: { values: ["--reason"], min: 1, max: 50 },
    "comments add": { min: 2, max: 2 },
    "dep add": { values: ["--type"], min: 2, max: 2 },
    graph: { flags: ["--all"], min: 0, max: 1 },
    search: { values: ["--query", "--status", "--limit"], min: 0, max: 0 },
    history: { values: ["--limit"], min: 1, max: 1 },
    types: { min: 0, max: 0 },
  };
const refuse = () => {
  throw new BoardError({ code: "forbidden", message: "This board command is not allowed." });
};
function allowedBoardMetadata(value: string): boolean {
  return (
    /^ardur_close_when_done=(true|false)$/.test(value) ||
    /^ardur_run_id=[A-Za-z0-9_-]{1,128}$/.test(value) ||
    /^ardur_bot_id=[A-Za-z0-9_-]{1,128}$/.test(value) ||
    /^ardur_filed_by=[\p{L}\p{N}][\p{L}\p{N} ._'’-]{0,79}$/u.test(value)
  );
}
/** Validate a complete command grammar. Global flags, file inputs and shell execution are absent. */
export function validateBoardArgv(argv: string[]) {
  if (!argv.length || argv.length > 128 || argv.some((s) => s.includes("\0") || s.length > 32_000))
    return refuse();
  const compound = ["comments", "dep"].includes(argv[0]!);
  const key = compound ? argv.slice(0, 2).join(" ") : argv[0]!;
  const spec = commands[key];
  if (!spec) return refuse();
  const positional: string[] = [];
  let literal = false;
  for (let i = compound ? 2 : 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!literal && arg === "--") {
      literal = true;
      continue;
    }
    if (!literal && arg.startsWith("-")) {
      if (spec.flags?.includes(arg)) continue;
      if (!spec.values?.includes(arg) || ++i >= argv.length) return refuse();
      if (arg === "--set-metadata" && !allowedBoardMetadata(argv[i]!)) return refuse();
      if (arg === "--limit" && !/^(0|[1-9][0-9]{0,3})$/.test(argv[i]!)) return refuse();
      continue;
    }
    positional.push(arg);
  }
  if (positional.length < spec.min || positional.length > spec.max) return refuse();
  for (const value of key === "comments add" ? positional.slice(0, 1) : positional)
    if (!BoardItemIdSchema.safeParse(value).success) return refuse();
  if (key === "graph" && positional.length === 0 && !argv.includes("--all")) return refuse();
  return {
    write:
      ["create", "update", "close", "comments add", "dep add"].includes(key) ||
      (key === "ready" && argv.includes("--claim")),
  };
}
