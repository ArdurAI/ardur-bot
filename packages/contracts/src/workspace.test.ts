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
  for (const type of ["preview", "plan", "unknown"])
    expect(WorkspaceViewSchema.safeParse({ type }).success).toBe(false);
});
it("requires an explicit bot/root/computer generation for file and change targets", () => {
  const target = {
    botId: "bot",
    rootId: "sandbox-computer",
    computerId: "computer",
    generation: 1,
  };
  const file = { view: { type: "ide" }, target, path: "src/main.ts", line: 12 };
  expect(WorkspaceOpenIntentSchema.safeParse(file).success).toBe(true);
  for (const invalid of [
    { ...file, target: { rootId: target.rootId } },
    { ...file, path: "../secret" },
    { ...file, line: 0 },
    { ...file, target: { ...target, generation: -1 } },
  ])
    expect(WorkspaceOpenIntentSchema.safeParse(invalid).success).toBe(false);
  expect(
    WorkspaceOpenIntentSchema.safeParse({
      view: { type: "changes" },
      target,
      changeId: "change",
      since: "2026-10-01T00:00:00Z",
      until: "2026-10-02T00:00:00Z",
    }).success,
  ).toBe(true);
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
