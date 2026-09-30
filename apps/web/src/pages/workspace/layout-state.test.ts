// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeWorkspaceView,
  defaultWorkspaceLayout,
  openWorkspaceView,
  readWorkspaceLayout,
  restoreWorkspaceLayout,
  workspaceLayoutKey,
  writeWorkspaceLayout,
} from "./layout-state";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
  msg: (parts: TemplateStringsArray) => parts,
}));

beforeEach(() => {
  const saved = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      clear: () => saved.clear(),
    },
  });
});

describe("workspace layout", () => {
  it("deduplicates opens and selects the adjacent view when closing", () => {
    const tasks = defaultWorkspaceLayout();
    const terminal = openWorkspaceView(tasks, "terminal");
    expect(openWorkspaceView(terminal, "terminal").open).toHaveLength(2);
    const files = openWorkspaceView(terminal, "files");
    expect(closeWorkspaceView(files, "files").active).toBe("terminal");
    expect(closeWorkspaceView(files, "tasks").active).toBe("files");
    const empty = closeWorkspaceView(tasks, "tasks");
    expect(empty).toMatchObject({ open: [], active: null, visible: false, expanded: false });
    expect(openWorkspaceView(empty, "routines")).toMatchObject({
      active: "routines",
      visible: true,
    });
  });
  it("ignores malformed, unknown, future and invalid selections", () => {
    for (const bad of [
      null,
      [],
      {},
      { ...defaultWorkspaceLayout(), version: 2 },
      { ...defaultWorkspaceLayout(), open: [{ type: "preview" }] },
      { ...defaultWorkspaceLayout(), active: "terminal" },
      { ...defaultWorkspaceLayout(), width: Infinity },
      { ...defaultWorkspaceLayout(), visible: "yes" },
    ]) {
      expect(restoreWorkspaceLayout(bad)).toEqual(defaultWorkspaceLayout());
    }
  });
  it("allowlists saved fields, deduplicates and clamps restored desktop dimensions", () => {
    expect(
      restoreWorkspaceLayout({
        ...defaultWorkspaceLayout(),
        width: 900,
        height: -10,
        open: [{ type: "tasks", token: "placeholder" }, { type: "tasks" }],
        output: "never store this",
        dirtyContent: "draft",
        url: "https://example.invalid",
      }),
    ).toEqual({ ...defaultWorkspaceLayout(), width: 800, height: 200 });
  });
  it("keeps each user, space and bot layout distinct and survives reopening", () => {
    const a = workspaceLayoutKey("user", "space", "a");
    const b = workspaceLayoutKey("user", "space", "b");
    expect(
      new Set([
        a,
        b,
        workspaceLayoutKey("other", "space", "a"),
        workspaceLayoutKey("user", "other", "a"),
      ]).size,
    ).toBe(4);
    const layout = {
      ...openWorkspaceView(defaultWorkspaceLayout(), "terminal"),
      width: 620,
      expanded: true,
      position: "left" as const,
    };
    writeWorkspaceLayout(a, layout);
    writeWorkspaceLayout(b, openWorkspaceView(defaultWorkspaceLayout(), "routines"));
    expect(readWorkspaceLayout(a)).toEqual(layout);
    expect(readWorkspaceLayout(b).active).toBe("routines");
    window.localStorage.setItem(a, "malformed");
    expect(readWorkspaceLayout(a)).toEqual(defaultWorkspaceLayout());
    window.localStorage.clear();
  });
});
