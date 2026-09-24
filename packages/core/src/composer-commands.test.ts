import type { AgentSkillCatalogEntry, TaughtSkill } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { canAddComposerFolder, composerCommands, composerSkills } from "./composer-commands.js";

const input = {
  query: "",
  skills: [{ id: "s", name: "Daily review", description: "Review changes" }],
  routines: [{ id: "r", name: "Weekly report", prompt: "Summarize the week", botId: "bot" }],
};
describe("composer commands", () => {
  it("orders built-ins, settings shortcuts, skills and routines", () => {
    expect(composerCommands(input).map((row) => row.name)).toEqual([
      "/new",
      "/stop",
      "/remember",
      "/routine",
      "/skills",
      "/model",
      "/settings",
      "/help",
      "/chat-settings",
      "/settings-general",
      "/settings-usage",
      "/Daily review",
      "/Weekly report",
    ]);
  });
  it("filters names and descriptions, preserving remember arguments", () => {
    expect(composerCommands({ ...input, query: "changes" }).map((row) => row.id)).toEqual([
      "skill:s",
    ]);
    expect(composerCommands({ ...input, query: "week" }).map((row) => row.id)).toEqual([
      "routine:r",
    ]);
    expect(
      composerCommands({ ...input, query: "remember keep this" }).map((row) => row.id),
    ).toEqual(["remember"]);
  });
  it("exposes compare only when both a flow and two bots exist", () => {
    for (const options of [
      { botCount: 1, compareAvailable: true },
      { botCount: 2, compareAvailable: false },
    ]) {
      expect(composerCommands({ ...input, ...options }).some((row) => row.id === "compare")).toBe(
        false,
      );
    }
    expect(
      composerCommands({ ...input, botCount: 2, compareAvailable: true }).some(
        (row) => row.id === "compare",
      ),
    ).toBe(true);
  });
  it("hides bot-specific actions in group composers", () => {
    const names = composerCommands({ ...input, botAvailable: false }).map((row) => row.id);
    for (const action of ["new", "remember", "routine", "model"])
      expect(names).not.toContain(action);
    expect(names).toContain("stop");
    expect(names).toContain("chat-settings");
  });
  it("lists only skills for /skills and excludes another bot's skills", () => {
    expect(composerCommands({ ...input, skillsOnly: true }).map((row) => row.kind)).toEqual([
      "skill",
    ]);
    const catalog = [
      { id: "one", name: "Review", description: "Old", botId: "bot" },
      { id: "other", name: "Private", botId: "other" },
    ] as AgentSkillCatalogEntry[];
    const taught = [
      { id: "saved", name: "Review", goal: "Saved steps", botId: "bot", status: "saved" },
      { id: "recording", name: "Unfinished", botId: "bot", status: "recording" },
    ] as TaughtSkill[];
    expect(composerSkills(catalog, taught, "bot")).toEqual([
      { id: "saved", name: "Review", description: "Saved steps" },
    ]);
  });
  it.each([
    [false, "desktop", false],
    [true, "docker", false],
    [true, "e2b", false],
    [true, undefined, false],
    [true, "desktop", true],
  ] as const)("folder availability (%s, %s)", (desktop, provider, expected) => {
    expect(canAddComposerFolder(desktop, provider)).toBe(expected);
  });
});
