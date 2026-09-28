// @vitest-environment jsdom
import type { DashboardNow, RunActivityRow, TeamRow } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import NowPanel from "./NowPanel";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));

const makeRun = (runId: string, status: RunActivityRow["status"], promptSnippet: string): RunActivityRow => ({
  runId,
  botId: "worker",
  botName: "Worker",
  groupId: null,
  groupName: null,
  threadId: "desk",
  status,
  trigger: "follow_up",
  notificationsEnabled: true,
  promptSnippet,
  updatedAt: new Date().toISOString(),
});

async function render(data: DashboardNow) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(MemoryRouter, null,
    createElement(NowPanel, {
      data: { ...data, spaceId: "space" },
      refresh: async () => {},
      openSettings: () => {},
      openLearning: () => {},
    }),
  )));
  return { node, close: async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); } };
}

it("shows the prompt belonging to each concurrent run", async () => {
  const row = { botId: "worker", availability: "busy", observedAt: new Date().toISOString(),
    activeRunIds: ["first", "second"], currentTaskTitle: "Latest task", delegations: [] } as TeamRow;
  const view = await render({
    runs: [makeRun("first", "running", "First task"), makeRun("second", "running", "Second task")],
    rows: [row], approvals: [],
  });
  try {
    expect(view.node.textContent).toContain("First task");
    expect(view.node.textContent).toContain("Second task");
    expect(view.node.textContent).not.toContain("Latest task");
  } finally { await view.close(); }
});

it("retains queued runs, owner-held takeover work, and queued delegations", async () => {
  const view = await render({
    runs: [
      makeRun("queued", "queued", "Queued research"),
      makeRun("held", "waiting_takeover", "Waiting for computer"),
    ],
    rows: [{
      botId: "worker",
      availability: "queued",
      observedAt: "2026-01-01T00:00:00.000Z",
      activeRunIds: [],
      delegations: [{ id: "delegation", actingBotId: "worker", status: "queued", card: { goal: "Queued handoff" } }],
    } as TeamRow],
    approvals: [],
  });
  try {
    expect(view.node.textContent).toContain("Queued research");
    expect(view.node.textContent).toContain("Waiting for computer");
    expect(view.node.textContent).toContain("Queued handoff");
    expect(view.node.textContent).toContain("Status unavailable");
    expect(view.node.textContent).not.toContain("Nothing running");
  } finally { await view.close(); }
});
