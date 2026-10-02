import { expect, it } from "vitest";
import {
  WorkspaceLayoutSchema,
  WorkspaceOpenIntentSchema,
  WorkspaceViewSchema,
} from "./workspace.js";

it("accepts backed view intents, not private targets or speculative renderers", () => {
  expect(WorkspaceOpenIntentSchema.safeParse({ view: { type: "terminal" } }).success).toBe(true);
  expect(
    WorkspaceViewSchema.safeParse({ type: "files", url: "https://example.invalid" }).success,
  ).toBe(false);
  for (const type of ["preview", "plan", "changes", "unknown"])
    expect(WorkspaceViewSchema.safeParse({ type }).success).toBe(false);
});
it("validates a presentation-only local layout", () => {
  const layout = {
    version: 1,
    open: [{ type: "tasks" }],
    active: "tasks",
    visible: true,
    expanded: false,
    position: "right",
    width: 480,
    height: 280,
  };
  expect(WorkspaceLayoutSchema.safeParse(layout).success).toBe(true);
  expect(WorkspaceLayoutSchema.safeParse({ ...layout, width: 900 }).success).toBe(false);
  expect(WorkspaceLayoutSchema.safeParse({ ...layout, token: "placeholder" }).success).toBe(false);
});
