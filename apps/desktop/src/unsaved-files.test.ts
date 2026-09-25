import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { UnsavedFiles } from "./unsaved-files.js";

it("keeps independent dirty windows and refuses untyped renderer state", () => {
  const state = new UnsavedFiles<object>(),
    first = {},
    second = {};
  state.set(first, true);
  expect(state.has(first)).toBe(true);
  expect(state.has(second)).toBe(false);
  expect(() => state.set(first, "false")).toThrow();
  expect(state.has(first)).toBe(true);
  state.set(first, false);
  expect(state.has(first)).toBe(false);
});
it("guards warm destruction and accepts dirty state only from the main frame", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  expect(source).toContain("!unsavedFiles.has(win)");
  expect(source).toContain("event.senderFrame !== win.webContents.mainFrame");
  expect(source).toContain('"will-prevent-unload"');
});
