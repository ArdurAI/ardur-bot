// @vitest-environment jsdom
import type { BoardSnapshot, WorkItem } from "@ardurbot/contracts/board";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { Board, BoardColumns } from "./Board";
import { DependencyGraph, graphPositions } from "./Graph";
import { ItemForm } from "./ItemForm";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../../components/ai/primitives", () => ({ LoadingState: () => <span>Loading…</span> }));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  Switch: () => null,
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
const calls = vi.hoisted(() => ({
  workspaces: vi.fn(),
  snapshot: vi.fn(),
  show: vi.fn(),
  start: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { board: calls } }));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.clearAllMocks();
  calls.workspaces.mockReset();
  calls.snapshot.mockReset();
  document.body.replaceChildren();
});
function item(id: string, status = "open"): WorkItem {
  return {
    id,
    title: id,
    description: "",
    acceptanceCriteria: "",
    type: "task",
    status,
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
    closedAt: status === "closed" ? new Date().toISOString() : null,
    commentCount: 0,
    comments: [],
    history: [],
    closeWhenDone: false,
  };
}
async function render(children: ReactNode) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () => root.render(<MemoryRouter>{children}</MemoryRouter>));
  return node;
}
it("preserves precise dates on unrelated edits and allows clearing or changing a date", async () => {
  const existing = {
    ...item("board-a"),
    dueAt: "2026-10-08T18:45:00Z",
    deferUntil: "2026-10-06T09:30:00Z",
  };
  const save = vi.fn(async () => undefined);
  const node = await render(<ItemForm item={existing} items={[]} bots={[]} save={save} />);
  node.querySelector<HTMLInputElement>('[name="title"]')!.value = "Updated title";
  await act(async () => {
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Updated title",
      dueAt: existing.dueAt,
      deferUntil: existing.deferUntil,
    }),
  );
  node.querySelector<HTMLInputElement>('[name="dueAt"]')!.value = "";
  node.querySelector<HTMLInputElement>('[name="deferUntil"]')!.value = "2026-10-09";
  await act(async () => {
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      dueAt: null,
      deferUntil: "2026-10-09T00:00:00.000Z",
    }),
  );
});
it("renders each column, hides old closures, and opens the selected item", async () => {
  const old = { ...item("old", "closed"), closedAt: "2000-01-01T00:00:00Z" };
  const snapshot: BoardSnapshot = {
    items: [
      item("ready"),
      item("working", "in_progress"),
      item("blocked"),
      item("deferred", "deferred"),
      item("done", "closed"),
      old,
    ],
    readyIds: ["ready"],
    blockedIds: ["blocked"],
  };
  const open = vi.fn();
  const node = await render(<BoardColumns snapshot={snapshot} onOpen={open} />);
  for (const [column, id] of [
    ["ready", "ready"],
    ["in_progress", "working"],
    ["blocked", "blocked"],
    ["deferred", "deferred"],
    ["done", "done"],
  ])
    expect(node.querySelector(`[data-board-column="${column}"] button`)?.textContent).toContain(id);
  expect(node.querySelectorAll("button")).toHaveLength(5);
  await act(async () => node.querySelector("button")!.click());
  expect(open).toHaveBeenCalledWith("ready");
});
it("keeps all five columns on an empty board", async () => {
  const node = await render(
    <BoardColumns
      snapshot={{ items: [], readyIds: [], blockedIds: [] }}
      onOpen={() => undefined}
    />,
  );
  expect(node.querySelectorAll("[data-board-column]")).toHaveLength(5);
  expect([...node.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
    "Ready",
    "In progress",
    "Blocked",
    "Deferred",
    "Done",
  ]);
  expect(node.querySelectorAll("button")).toHaveLength(0);
});
it("shows installation help only when Beads is missing", async () => {
  calls.workspaces.mockResolvedValue({
    workspaces: [],
    problem: { code: "not_installed", message: "Beads is not installed on this computer" },
  });
  const node = await render(<Board />);
  expect(node.textContent).toContain("Beads is not installed on this computer");
  expect(node.querySelector("a")?.href).toContain("github.com/gastownhall/beads");
  expect(node.textContent).toContain("brew install beads");
  expect(calls.start).not.toHaveBeenCalled();
});
it("retries discovery after an initial workspace request fails", async () => {
  vi.useFakeTimers();
  try {
    calls.workspaces.mockRejectedValueOnce(new Error("Host disconnected")).mockResolvedValueOnce({
      workspaces: [
        {
          id: "space-board",
          kind: "space",
          name: "Board",
          path: "/fixture/board",
          enabled: true,
          initialized: true,
          prefix: "board",
        },
      ],
      problem: null,
    });
    calls.snapshot.mockResolvedValue({
      items: [item("recovered")],
      readyIds: ["recovered"],
      blockedIds: [],
    });
    const node = await render(<Board />);
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("Host disconnected");
    await act(async () => node.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(calls.workspaces).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(calls.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "space-board" }),
    );
    expect(node.querySelector('[data-board-column="ready"]')?.textContent).toContain("recovered");
    expect(node.querySelector('[role="alert"]')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
it("previews folder initialization without writing until the owner acts", async () => {
  calls.workspaces.mockResolvedValue({
    workspaces: [
      {
        id: "folder",
        kind: "folder",
        name: "Project",
        path: "/fixture/project",
        enabled: true,
        initialized: false,
        prefix: "board",
      },
    ],
    problem: null,
  });
  const node = await render(<Board />);
  const select = node.querySelector("select")!;
  await act(async () => {
    select.value = "folder";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((button) => button.textContent === "Start a board in this folder")!
      .click(),
  );
  expect(node.querySelector("[role=dialog]")?.textContent).toContain(".beads/");
  expect(calls.start).not.toHaveBeenCalled();
});
it("lays prerequisites before dependents and makes graph nodes keyboard accessible", async () => {
  const graph = { items: [item("a"), item("b")], edges: [{ from: "b", to: "a", type: "blocks" }] };
  const positions = graphPositions(graph);
  expect(positions.get("a")!.x).toBeLessThan(positions.get("b")!.x);
  const open = vi.fn();
  const node = await render(<DependencyGraph graph={graph} onOpen={open} />);
  await act(async () =>
    node
      .querySelector("g[role=button]")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(open).toHaveBeenCalledWith("a");
  expect(node.querySelectorAll("svg")).toHaveLength(1);
});
