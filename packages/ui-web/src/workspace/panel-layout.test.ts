import { expect, it } from "vitest";
import { clampWorkspacePanelSize, workspacePanelLayout } from "./panel-layout.js";

it("clamps a measured split while reserving chat and leaves desktop preference separate", () => {
  expect(clampWorkspacePanelSize({ size: 700, available: undefined, stacked: false })).toBe(700);
  expect(clampWorkspacePanelSize({ size: 700, available: 1000, stacked: false })).toBe(600);
  expect(clampWorkspacePanelSize({ size: 700, available: 1500, stacked: false })).toBe(700);
  expect(clampWorkspacePanelSize({ size: -10, available: 1000, stacked: false })).toBe(360);
  expect(clampWorkspacePanelSize({ size: 500, available: 680, stacked: true })).toBe(400);
});
it("derives docking, stacked splits and overlays without modifying saved sizes", () => {
  const base = {
    open: true,
    expanded: false,
    narrow: false,
    available: 1200,
    position: "right" as const,
  };
  expect(workspacePanelLayout(base)).toEqual({ visible: true, stacked: false, overlay: false });
  expect(workspacePanelLayout({ ...base, position: "bottom" }).stacked).toBe(true);
  expect(workspacePanelLayout({ ...base, available: 700 }).overlay).toBe(true);
  expect(workspacePanelLayout({ ...base, narrow: true }).overlay).toBe(true);
  expect(workspacePanelLayout({ ...base, expanded: true }).overlay).toBe(true);
});
