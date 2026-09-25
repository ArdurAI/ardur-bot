// @vitest-environment jsdom

import type { WorkItem } from "@ardurbot/contracts/board";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import WorkPanel from "./WorkPanel";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));

function workItem(id: string, title: string): WorkItem {
  return {
    id,
    title,
    description: "",
    acceptanceCriteria: "",
    type: "task",
    status: "open",
    priority: 2,
    assignee: null,
    labels: [],
    parent: null,
    dependencies: [],
    dueAt: null,
    deferUntil: null,
    estimateMinutes: null,
    externalRef: null,
    createdAt: "",
    updatedAt: "",
    closedAt: null,
    commentCount: 0,
    comments: [],
    history: [],
    closeWhenDone: false,
  };
}

const nodes: Array<{ node: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];
afterEach(async () => {
  for (const entry of nodes.splice(0))
    await act(async () => {
      entry.root.unmount();
      entry.node.remove();
    });
});

it.each([
  [0, 0, 0, 0],
  [1, 1, 0, 0],
  [6, 2, 3, 1],
])("renders the per-bot filing line for %i filings", async (filed, done, open, other) => {
  const node = document.createElement("div");
  const root = createRoot(node);
  nodes.push({ node, root });
  await act(async () =>
    root.render(
      <MemoryRouter>
        <WorkPanel
          openSettings={vi.fn()}
          openLearning={vi.fn()}
          refresh={vi.fn()}
          data={{
            workspace: {
              id: "board",
              kind: "space",
              path: "",
              prefix: "work",
              name: "Work",
              enabled: true,
              initialized: true,
              isDefault: true,
              allowAllBots: true,
              allowedBotIds: [],
            },
            ready: 0,
            inProgress: 0,
            blocked: 0,
            items: [],
            filingOutcomes: [{ botId: "bot", name: "Helper", filed, done, open, other }],
          }}
        />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toContain(
    `Helper filed ${filed}: ${done} done, ${open} open, ${other} closed without being completed.`,
  );
  expect(node.textContent).not.toContain("closed otherwise");
});

it("shows ready work and a quiet line when outcomes are unavailable", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  nodes.push({ node, root });
  await act(async () =>
    root.render(
      <MemoryRouter>
        <WorkPanel
          openSettings={vi.fn()}
          openLearning={vi.fn()}
          refresh={vi.fn()}
          data={{
            workspace: {
              id: "board",
              kind: "space",
              path: "",
              prefix: "work",
              name: "Work",
              enabled: true,
              initialized: true,
              isDefault: true,
              allowAllBots: true,
              allowedBotIds: [],
            },
            ready: 2,
            inProgress: 0,
            blocked: 0,
            items: [workItem("work-1", "Next work")],
            filingOutcomes: [],
            outcomesUnavailable: true,
          }}
        />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toContain("Ready: 2");
  expect(node.textContent).toContain("Next work");
  expect(node.textContent).toContain("Board outcomes are unavailable right now.");
  expect(node.textContent).not.toContain("Could not load");
  expect(node.textContent).not.toContain("closed without being completed");
});
