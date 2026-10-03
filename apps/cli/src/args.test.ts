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
