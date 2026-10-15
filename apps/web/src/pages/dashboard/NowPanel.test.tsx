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
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
}));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));

const makeRun = (
  runId: string,
  status: RunActivityRow["status"],
  promptSnippet: string,
): RunActivityRow => ({
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
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(NowPanel, {
          data: { ...data, spaceId: "space" },
          refresh: async () => {},
          openSettings: () => {},
          openLearning: () => {},
        }),
      ),
    ),
  );
  return {
    node,
    close: async () => {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it("shows the prompt belonging to each concurrent run", async () => {
  const row = {
    botId: "worker",
    availability: "busy",
    observedAt: new Date().toISOString(),
    activeRunIds: ["first", "second"],
    currentTaskTitle: "Latest task",
    delegations: [],
  } as unknown as TeamRow;
  const view = await render({
    runs: [makeRun("first", "running", "First task"), makeRun("second", "running", "Second task")],
    rows: [row],
    approvals: [],
  });
  try {
    expect(view.node.textContent).toContain("First task");
    expect(view.node.textContent).toContain("Second task");
    expect(view.node.textContent).not.toContain("Latest task");
  } finally {
    await view.close();
  }
});

it("retains queued runs, owner-held takeover work, and queued delegations", async () => {
  const view = await render({
    runs: [
      makeRun("queued", "queued", "Queued research"),
      makeRun("held", "waiting_takeover", "Waiting for computer"),
    ],
    rows: [
      {
        botId: "worker",
        availability: "queued",
        observedAt: "2026-01-01T00:00:00.000Z",
        activeRunIds: [],
        delegations: [
          {
            id: "delegation",
            actingBotId: "worker",
            status: "queued",
            card: { goal: "Queued handoff" },
          },
        ],
      } as unknown as TeamRow,
    ],
    approvals: [],
  });
  try {
    expect(view.node.textContent).toContain("Queued research");
    expect(view.node.textContent).toContain("Waiting for computer");
    expect(view.node.textContent).toContain("Queued handoff");
    expect(view.node.textContent).toContain("Status unavailable");
    expect(view.node.textContent).toContain("Needs takeover");
    const takeover = [...view.node.querySelectorAll('a[href="/app/worker"]')].find((link) =>
      link.textContent?.includes("Waiting for computer"),
    );
    expect(takeover?.textContent).not.toContain("Status unavailable");
    expect(view.node.textContent).not.toContain("Nothing running");
  } finally {
    await view.close();
  }
});

it("shows running time as a human duration instead of bare seconds", async () => {
  const run = (runId: string, minutesAgo: number) => ({
    ...makeRun(runId, "running", `${runId} task`),
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
  const row = {
    botId: "worker",
    availability: "busy",
    observedAt: new Date().toISOString(),
    activeRunIds: ["half", "long", "hour"],
    currentTaskTitle: null,
    delegations: [],
  } as unknown as TeamRow;
  const view = await render({
    runs: [run("half", 0.75), run("long", 27), run("hour", 65)],
    rows: [row],
    approvals: [],
  });
  try {
    expect(view.node.textContent).toContain("45s");
    expect(view.node.textContent).toContain("27 min");
    expect(view.node.textContent).toContain("1 h 5 min");
    expect(view.node.textContent).not.toContain("1620s");
    expect(view.node.textContent).not.toContain("3900s");
  } finally {
    await view.close();
  }
});
