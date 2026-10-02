import type { ComputerStatus, WorkspaceContext } from "@ardurbot/contracts";
import { WorkspaceViewIdSchema } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { availableWorkspaceViews, isWorkspaceViewId, workspaceViews } from "./view-registry";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
  msg: (parts: TemplateStringsArray) => parts,
}));

const computer = {
  computerId: "computer",
  kind: "docker",
  state: "running",
  capabilities: { graphical: true, interactiveTerminal: true },
} as ComputerStatus;
const context: WorkspaceContext = {
  botId: "bot",
  computerId: "computer",
  generation: 1,
  files: "live",
  runsOnHost: false,
  observedAt: "2026-09-28T00:00:00.000Z",
};
describe("workspace registry", () => {
  it("has exactly one definition for every contract view, no speculative views", () => {
    expect(Object.keys(workspaceViews)).toEqual(WorkspaceViewIdSchema.options);
    expect(isWorkspaceViewId("preview")).toBe(false);
    expect(isWorkspaceViewId("plan")).toBe(false);
    expect(isWorkspaceViewId("constructor")).toBe(false);
    expect(isWorkspaceViewId("terminal")).toBe(true);
  });
  it("offers only backed capabilities, while retaining definitions for lost capabilities", () => {
    expect(availableWorkspaceViews({ computer, context }).map((view) => view.id)).toEqual([
      "tasks",
      "files",
      "terminal",
      "routines",
      "screen",
    ]);
    expect(availableWorkspaceViews({ computer: null }).map((view) => view.id)).toEqual([
      "tasks",
      "routines",
      "computer",
    ]);
    expect(
      workspaceViews.screen.available({
        computer: { ...computer, capabilities: { graphical: false, interactiveTerminal: true } },
      }),
    ).toBe(false);
    expect(
      availableWorkspaceViews({ computer, context: null, terminal: false }).map((view) => view.id),
    ).toEqual(["tasks", "routines", "screen"]);
  });
  it("uses only described file policy, not a computer kind or saved connection", () => {
    expect(workspaceViews.files.available({ computer })).toBe(false);
    expect(
      workspaceViews.files.available({ computer, context: { ...context, files: "unavailable" } }),
    ).toBe(false);
    expect(
      workspaceViews.files.available({
        computer: { ...computer, kind: "desktop", connectionId: "saved-container" },
        context,
      }),
    ).toBe(true);
  });
});
