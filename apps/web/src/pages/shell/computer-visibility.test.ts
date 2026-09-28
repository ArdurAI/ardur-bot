import { describe, expect, it } from "vitest";
import { isComputerVisible } from "./computer-visibility";

describe("isComputerVisible", () => {
  it("returns true when computer is fully open", () => {
    expect(isComputerVisible(true, null, "tasks")).toBe(true);
  });

  it("returns false when panel is computer but tab is tasks", () => {
    expect(isComputerVisible(false, "computer", "tasks")).toBe(false);
  });

  it("returns false when panel is computer but tab is files", () => {
    expect(isComputerVisible(false, "computer", "files")).toBe(false);
  });

  it("returns true when panel is computer and tab is screen", () => {
    expect(isComputerVisible(false, "computer", "screen")).toBe(true);
  });

  it("returns true when panel is computer and tab is computer", () => {
    expect(isComputerVisible(false, "computer", "computer")).toBe(true);
  });
});

import { getEffectiveWorkspaceTab } from "./computer-visibility";

describe("getEffectiveWorkspaceTab", () => {
  it("resolves unsupported screen to tasks on non-graphical", () => {
    expect(getEffectiveWorkspaceTab("screen", false)).toBe("tasks");
  });

  it("resolves unsupported computer to tasks on graphical", () => {
    expect(getEffectiveWorkspaceTab("computer", true)).toBe("tasks");
  });

  it("keeps screen on graphical", () => {
    expect(getEffectiveWorkspaceTab("screen", true)).toBe("screen");
  });

  it("keeps computer on non-graphical", () => {
    expect(getEffectiveWorkspaceTab("computer", false)).toBe("computer");
  });

  it("resolves files to tasks when files are unavailable", () => {
    expect(getEffectiveWorkspaceTab("files", true, false)).toBe("tasks");
  });
});
