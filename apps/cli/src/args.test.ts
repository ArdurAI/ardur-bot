import { expect, it } from "vitest";
import { parseArgs } from "./args.js";

it.each([
  [[], { kind: "help" }],
  [["--help"], { kind: "help" }],
  [["pair", "code"], { kind: "pair", code: "code", json: false }],
  [["bots", "--json"], { kind: "bots", json: true }],
  [["send", "Review"], { kind: "send", text: "Review", wait: false }],
  [
    ["send", "builder", "Review", "--wait", "--json"],
    { kind: "send", bot: "builder", text: "Review", wait: true, json: true },
  ],
  [["send", "builder", "--file", "brief.md"], { kind: "send", bot: "builder", file: "brief.md" }],
  [["send", "--", "--literal"], { kind: "send", text: "--literal" }],
  [["stop", "task"], { kind: "stop", taskId: "task" }],
  [["status"], { kind: "status" }],
] as const)("parses %j", (args, result) => expect(parseArgs([...args])).toMatchObject(result));
it.each([
  ["unknown"],
  ["pair"],
  ["pair", "one", "two"],
  ["bots", "bot"],
  ["send"],
  ["send", "--file"],
  ["send", "--file", "--wait"],
  ["send", "bot", "text", "--file", "brief"],
  ["send", "one", "two", "three"],
  ["send", "text", "--json", "--json"],
  ["status", "--wait"],
  ["stop"],
  ["send", "text", "--unknown"],
])("refuses ambiguous or invalid args %j", (args) => {
  expect(() => parseArgs(args)).toThrow();
  try {
    parseArgs(args);
  } catch (error) {
    expect(error).toMatchObject({ exitCode: 3 });
  }
});

it.each([
  ["180s", 180000],
  ["2m", 120000],
  ["500ms", 500],
  ["0.5", 500],
])("parses bot test timeout %s", (value, timeoutMs) => {
  expect(
    parseArgs([
      "test",
      "bot",
      "bot-id",
      "--prompt",
      "hello",
      "--expect-contains",
      "world",
      "--timeout",
      value,
    ]),
  ).toMatchObject({
    kind: "test",
    bot: "bot-id",
    prompt: "hello",
    expectContains: "world",
    timeoutMs,
    json: false,
  });
});
it.each([
  ["test", "room", "room-id"],
  ["test", "bot"],
  ["test", "bot", "bot-id", "--json", "--json"],
  ["test", "bot", "bot-id", "--prompt", "hello", "--prompt", "again", "--expect-contains", "world"],
  [
    "test",
    "bot",
    "bot-id",
    "--prompt",
    "hello",
    "--expect-contains",
    "world",
    "--timeout",
    "2147483648ms",
  ],
])("refuses invalid bot test arguments %j", (input) => {
  expect(() => parseArgs(input)).toThrow();
});

it.each([
  [
    ["runs", "list", "--limit", "2", "--cursor", "run"],
    { kind: "runs-list", limit: 2, cursor: "run" },
  ],
  [["runs", "show", "run"], { kind: "runs-show", runId: "run" }],
  [["tasks", "show", "task"], { kind: "tasks-show", taskId: "task" }],
  [["wait", "--run", "run", "--timeout", "2s"], { kind: "wait", runId: "run", timeoutMs: 2000 }],
  [
    ["send", "Hello", "--request-id", "stable-request-0001"],
    { kind: "send", requestId: "stable-request-0001" },
  ],
])("parses the exact-read and recovery command %j", (args, expected) =>
  expect(parseArgs(args as string[])).toMatchObject(expected),
);
it.each([
  ["runs", "list", "--limit", "101"],
  ["runs", "list", "--cursor"],
  ["wait"],
  ["wait", "--run", "one", "--run", "two"],
  ["wait", "--run", "run", "--timeout", "0"],
  ["send", "Hello", "--request-id", "short"],
  ["tasks", "show"],
  ["runs", "show", "run", "extra"],
])("refuses invalid Stage 3 arguments %j", (args) => expect(() => parseArgs(args)).toThrow());
