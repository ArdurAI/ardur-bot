import { describe, expect, it } from "vitest";
import { HERMES_SOURCE_PIN } from "./hermes-install.js";
import { hermesToolName, hermesToolNames } from "./hermes-tool-names.js";

describe("pinned Hermes MCP name contract", () => {
  it("requires requalification when the pin changes", () => {
    expect(HERMES_SOURCE_PIN).toBe("29112bef099274229cadff79cdff7bf7b99c4b77");
    expect(hermesToolName("mcp__fixture-app__read.file")).toBe(
      "mcp__ardur__mcp__fixture_app__read_file",
    );
  });
  it("keeps plain names, excludes helpers and sorts the exact attested surface", () => {
    expect(hermesToolNames([{ name: "z" }, { name: "run_subagent" }, { name: "a" }])).toEqual([
      "mcp__ardur__a",
      "mcp__ardur__z",
    ]);
    expect(hermesToolNames("none")).toEqual([]);
  });
  it.each([
    ["read-file", "read_file"],
    ["read.file", "read_file"],
    ["same", "same"],
  ])("refuses %s colliding with %s", (first, second) => {
    expect(() => hermesToolNames([{ name: first }, { name: second }])).toThrow(
      "Hermes tool names collide.",
    );
  });
});
