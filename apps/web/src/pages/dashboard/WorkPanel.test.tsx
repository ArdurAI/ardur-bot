// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import type { WorkItem } from "@ardurbot/contracts/board";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import WorkPanel, { load } from "./WorkPanel";

const board = vi.hoisted(() => ({ work: vi.fn(), filingOutcomes: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { board } }));

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

it("shows ready work and leaves the counts out when there are none", async () => {
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
          }}
        />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toContain("Ready: 2");
  expect(node.textContent).toContain("Next work");
  expect(node.textContent).not.toContain("Board outcomes");
  expect(node.textContent).not.toContain("closed without being completed");
});

it("drops the unavailable-outcomes line from every web locale", () => {
  for (const locale of ["en", "de", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])
    expect(
      readFileSync(path.join(import.meta.dirname, "../../locales", locale, "messages.po"), "utf8"),
      locale,
    ).not.toContain("Board outcomes are unavailable right now.");
});

it("asks for the work list and the filing counts at once", async () => {
  let finishWork!: (work: unknown) => void;
  board.work.mockReturnValue(
    new Promise((resolve) => {
      finishWork = resolve;
    }),
  );
  board.filingOutcomes.mockResolvedValue({
    bots: [{ botId: "bot", name: "Helper", filed: 1, done: 1, open: 0, other: 0 }],
  });
  const loading = load({ spaceId: "space", signal: new AbortController().signal });
  await vi.waitFor(() => expect(board.work).toHaveBeenCalledOnce());
  // The counts do not wait for the work list.
  expect(board.filingOutcomes).toHaveBeenCalledOnce();
  finishWork({ workspace: null, ready: 0, inProgress: 0, blocked: 0, items: [] });
  await expect(loading).resolves.toMatchObject({
    ready: 0,
    filingOutcomes: [{ botId: "bot", done: 1 }],
  });
});

it("keeps the work list when the filing counts fail", async () => {
  board.work.mockResolvedValue({ workspace: null, ready: 3, inProgress: 0, blocked: 0, items: [] });
  board.filingOutcomes.mockRejectedValue(new Error("outcomes unavailable"));
  await expect(
    load({ spaceId: "space", signal: new AbortController().signal }),
  ).resolves.toMatchObject({ ready: 3, filingOutcomes: [] });
});
