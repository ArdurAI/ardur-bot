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
