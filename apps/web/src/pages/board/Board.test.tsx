// @vitest-environment jsdom
import type { BoardSnapshot, WorkItem } from "@ardurbot/contracts/board";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Board, BoardColumns } from "./Board";
import { DependencyGraph, graphPositions } from "./Graph";
import { ItemForm } from "./ItemForm";

const translate = (parts: TemplateStringsArray) => parts.join("");
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: translate }),
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
  view: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  follow: vi.fn(),
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
  localStorage.clear();
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
async function render(children: ReactNode, path = "/") {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () =>
    root.render(<MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>),
  );
  return node;
}
it("shows a filed-by marker that links to the run", async () => {
  const filed = {
    ...item("board-a"),
    filedBy: { botId: "builder", botName: "Builder", runId: "run-1" },
  };
  const node = await render(
    <BoardColumns
      snapshot={{
        items: [filed],
        readyIds: ["board-a"],
        blockedIds: [],
      }}
      onOpen={() => undefined}
    />,
  );
  const link = node.querySelector<HTMLAnchorElement>('a[href="/app/builder?run=run-1"]');
  expect(link?.textContent).toContain("Builder");
});
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
  expect(
    [...node.querySelectorAll("h2")].map((heading) => heading.textContent?.replace(/ 0$/, "")),
  ).toEqual(["Ready", "In progress", "Blocked", "Deferred", "Done"]);
  expect(node.querySelectorAll("button")).toHaveLength(0);
});
const workspace = {
  id: "workspace",
  kind: "space",
  name: "Work",
  path: "/fixture/board",
  enabled: true,
  initialized: true,
  prefix: "work",
  isDefault: true,
  allowAllBots: true,
  allowedBotIds: [],
};
const view = (items: WorkItem[] = [item("ready")]) => ({
  workspaces: [workspace],
  workspaceId: workspace.id,
  snapshot: {
    items,
    allItems: items,
    readyIds: items.filter((item) => item.status === "open").map((item) => item.id),
    blockedIds: [],
  },
  selected: null,
  bots: [],
  followingIds: [],
  problem: null,
});
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    clear: () => values.clear(),
  });
  calls.view.mockReset().mockResolvedValue(view());
  calls.update.mockReset();
  calls.create.mockReset();
});
it("links an empty board to Settings without initialization controls", async () => {
  calls.view.mockResolvedValue({ ...view([]), workspaces: [], workspaceId: null });
  const openSettings = vi.fn();
  const node = await render(<Board openSettings={openSettings} />);
  expect(node.textContent).toContain("No board");
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((button) => button.textContent === "Set up a board")!
      .click(),
  );
  expect(openSettings).toHaveBeenCalledOnce();
  expect(calls.start).not.toHaveBeenCalled();
  expect(node.textContent).not.toContain("Start a board in this folder");
});
it("bounds slow summary polling independently of item count and skips hidden windows", async () => {
  vi.useFakeTimers();
  let resolve!: (value: ReturnType<typeof view>) => void;
  calls.view.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const node = await render(<Board />);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(calls.view).toHaveBeenCalledTimes(1);
  await act(async () =>
    resolve(view(Array.from({ length: 5000 }, (_, index) => item(`work-${index}`)))),
  );
  expect(node.querySelectorAll("[data-board-item]").length).toBeLessThanOrEqual(12);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(calls.view).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("moves immediately on drop and rolls back on command rejection", async () => {
  let reject!: (reason: Error) => void;
  calls.update.mockImplementation(
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  const node = await render(<Board />);
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { getData: () => "ready" } });
  await act(async () =>
    node.querySelector('[data-board-column="in_progress"]')!.dispatchEvent(event),
  );
  expect(
    node.querySelector('[data-board-column="in_progress"] [data-board-item="ready"]'),
  ).not.toBeNull();
  expect(calls.update).toHaveBeenCalledWith({
    workspaceId: "workspace",
    id: "ready",
    patch: { status: "in_progress", deferUntil: null },
  });
  await act(async () => reject(new Error("command refused")));
  expect(
    node.querySelector('[data-board-column="ready"] [data-board-item="ready"]'),
  ).not.toBeNull();
  expect(node.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not update this item.",
  );
});
it("undoes a successful drop through the same authorized update", async () => {
  let current = item("ready");
  calls.view.mockImplementation(async () => view([current]));
  calls.update.mockImplementation(async ({ patch }) => {
    current = { ...current, ...patch };
    return current;
  });
  const node = await render(<Board />);
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { getData: () => "ready" } });
  await act(async () =>
    node.querySelector('[data-board-column="in_progress"]')!.dispatchEvent(event),
  );
  expect(
    node.querySelector('[data-board-column="in_progress"] [data-board-item="ready"]'),
  ).not.toBeNull();
  await act(async () =>
    [...node.querySelectorAll("button")].find((button) => button.textContent === "Undo")!.click(),
  );
  expect(calls.update).toHaveBeenLastCalledWith({
    workspaceId: "workspace",
    id: "ready",
    patch: { status: "open", deferUntil: null },
  });
  expect(
    node.querySelector('[data-board-column="ready"] [data-board-item="ready"]'),
  ).not.toBeNull();
});
it("keeps Undo bound to the original board after switching workspaces", async () => {
  calls.view.mockImplementation(async ({ workspaceId }) => ({
    ...view(),
    workspaceId: workspaceId ?? "workspace",
    workspaces: [workspace, { ...workspace, id: "folder", name: "Folder" }],
  }));
  calls.update.mockResolvedValue(item("ready", "in_progress"));
  const node = await render(<Board />);
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { getData: () => "ready" } });
  await act(async () =>
    node.querySelector('[data-board-column="in_progress"]')!.dispatchEvent(event),
  );
  const select = node.querySelector<HTMLSelectElement>('select[aria-label="Board"]')!;
  await act(async () => {
    select.value = "folder";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(select.value).toBe("folder");
  await act(async () =>
    [...node.querySelectorAll("button")].find((button) => button.textContent === "Undo")!.click(),
  );
  expect(calls.update).toHaveBeenLastCalledWith({
    workspaceId: "workspace",
    id: "ready",
    patch: { status: "open", deferUntil: null },
  });
});
it("removes the previous board's editing controls while the next workspace loads", async () => {
  const workspaces = [workspace, { ...workspace, id: "folder", name: "Folder" }];
  calls.view.mockResolvedValueOnce({ ...view(), workspaces });
  let resolve!: (result: ReturnType<typeof view>) => void;
  calls.view.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const node = await render(<Board />);
  const select = node.querySelector<HTMLSelectElement>('select[aria-label="Board"]')!;
  await act(async () => {
    select.value = "folder";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(node.querySelectorAll('[aria-label="New item"]')).toHaveLength(0);
  expect(
    [...node.querySelectorAll("button")].some((button) => button.textContent === "New item"),
  ).toBe(false);
  expect(node.textContent).toContain("Loading");
  expect(node.textContent).not.toContain("No board");
  await act(async () => resolve({ ...view(), workspaces, workspaceId: "folder" }));
  expect(node.querySelectorAll('[aria-label="New item"]')).toHaveLength(5);
});
it.each(["succeeds", "fails"])(
  "refreshes the selected board after an earlier board's pending mutation %s",
  async (outcome) => {
    const workspaces = [workspace, { ...workspace, id: "folder", name: "Folder" }];
    calls.view.mockImplementation(async ({ workspaceId }) => ({
      ...view([item(workspaceId === "folder" ? "folder-item" : "ready")]),
      workspaces,
      workspaceId: workspaceId ?? "workspace",
    }));
    let complete!: () => void;
    calls.update.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          complete = () =>
            outcome === "succeeds" ? resolve() : reject(new Error("command refused"));
        }),
    );
    const node = await render(<Board />);
    const drop = (id: string) => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { getData: () => id } });
      node.querySelector('[data-board-column="in_progress"]')!.dispatchEvent(event);
    };
    await act(async () => drop("ready"));
    await act(async () => {
      const select = node.querySelector<HTMLSelectElement>('select[aria-label="Board"]')!;
      select.value = "folder";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => complete());
    expect(node.querySelector('[data-board-item="folder-item"]')).not.toBeNull();
    expect(node.querySelector('[data-board-item="ready"]')).toBeNull();
    expect(calls.view).toHaveBeenLastCalledWith(
      { workspaceId: "folder", itemId: undefined },
      expect.anything(),
    );
    await act(async () => drop("folder-item"));
    expect(calls.update).toHaveBeenLastCalledWith({
      workspaceId: "folder",
      id: "folder-item",
      patch: { status: "in_progress", deferUntil: null },
    });
  },
);
it("does not restore an edited item after switching boards while the save is pending", async () => {
  const workspaces = [workspace, { ...workspace, id: "folder", name: "Folder" }];
  calls.view.mockResolvedValueOnce({ ...view(), workspaces, selected: item("ready") });
  let loadFolder!: (result: ReturnType<typeof view>) => void;
  calls.view.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        loadFolder = resolve;
      }),
  );
  let save!: (item: WorkItem) => void;
  calls.update.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        save = resolve;
      }),
  );
  const node = await render(<Board />, "/app/board?workspace=workspace&item=ready");
  await act(async () =>
    [...node.querySelectorAll("button")].find((button) => button.textContent === "Edit")!.click(),
  );
  await act(async () =>
    node
      .querySelector('[role="dialog"] form')!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await act(async () => {
    const select = node.querySelector<HTMLSelectElement>('select[aria-label="Board"]')!;
    select.value = "folder";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => save(item("ready")));
  expect(node.querySelector('[role="dialog"]')).toBeNull();
  await act(async () =>
    loadFolder({ ...view([item("folder-item")]), workspaces, workspaceId: "folder" }),
  );
  expect(node.querySelector('[data-board-item="folder-item"]')).not.toBeNull();
});
it("opens the requested graph item without reloading the prior selection", async () => {
  calls.view.mockImplementation(async ({ itemId }) => ({
    ...view(),
    selected: itemId ? item(itemId) : null,
  }));
  const node = await render(<Board />);
  await act(async () => {
    const select = node.querySelector<HTMLSelectElement>('select[aria-label="View"]')!;
    select.value = "graph";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () =>
    node
      .querySelector<SVGGElement>('g[role="button"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  expect(node.querySelector('[role="dialog"] h2')?.textContent).toBe("ready");
  expect(calls.view).toHaveBeenLastCalledWith(
    { workspaceId: "workspace", itemId: "ready" },
    expect.anything(),
  );
});
it("keeps cards visible and clears an unavailable item selection", async () => {
  calls.view.mockImplementation(async ({ itemId }) => ({
    ...view(),
    selectionProblem: itemId ? { code: "command_failed", message: "Item not found" } : null,
  }));
  const node = await render(<Board />, "/app/board?workspace=workspace&item=deleted");
  expect(node.querySelector('[data-board-item="ready"]')).not.toBeNull();
  const close = [...node.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(
    (button) => button.textContent === "Close",
  );
  expect(close).toBeDefined();
  await act(async () => close!.click());
  expect(calls.view).toHaveBeenLastCalledWith(
    { workspaceId: "workspace", itemId: undefined },
    expect.anything(),
  );
  expect(node.querySelector('[role="alert"]')).toBeNull();
});
function input(node: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}
it("quick-adds in the column and persists filters without another summary request", async () => {
  calls.create.mockResolvedValue(item("new"));
  const node = await render(<Board scope="owner:space" />);
  await act(async () =>
    input(node.querySelector<HTMLInputElement>('[data-board-column="blocked"] input')!, "New work"),
  );
  await act(async () =>
    node
      .querySelector('[data-board-column="blocked"] form')!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(calls.create).toHaveBeenCalledWith({
    workspaceId: "workspace",
    item: { title: "New work", type: "task", priority: 2 },
  });
  expect(calls.update).toHaveBeenCalledWith({
    workspaceId: "workspace",
    id: "new",
    patch: { status: "blocked" },
  });
  const before = calls.view.mock.calls.length;
  await act(async () =>
    input(node.querySelector<HTMLInputElement>('[aria-label="Search"]')!, "missing"),
  );
  expect(node.querySelectorAll("[data-board-item]")).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem("ardurbot:board-filters:owner:space")!)).toMatchObject({
    search: "missing",
  });
  expect(calls.view).toHaveBeenCalledTimes(before);
});
it("shows the selected item from the summary and toggles the per-user follow", async () => {
  calls.view.mockResolvedValue({ ...view(), selected: item("ready") });
  calls.follow.mockResolvedValue({ following: true });
  const node = await render(<Board />);
  await act(async () =>
    [...node.querySelectorAll("button")].find((button) => button.textContent === "Follow")!.click(),
  );
  expect(calls.follow).toHaveBeenCalledWith({
    workspaceId: "workspace",
    id: "ready",
    following: true,
  });
  expect(calls.show).not.toHaveBeenCalled();
  const status = node.querySelector<HTMLSelectElement>('[aria-label="Status"]')!;
  await act(async () => {
    status.value = "blocked";
    status.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(calls.update).toHaveBeenCalledWith({
    workspaceId: "workspace",
    id: "ready",
    patch: { status: "blocked", deferUntil: null },
  });
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

it("reaches virtualized items with the keyboard", async () => {
  const items = Array.from({ length: 1000 }, (_, index) => item(`task-${index}`));
  const node = await render(
    <BoardColumns
      snapshot={{ items, readyIds: items.map((row) => row.id), blockedIds: [] }}
      onOpen={vi.fn()}
    />,
  );
  const first = node.querySelector<HTMLButtonElement>('[data-board-item="task-0"]')!;
  first.focus();
  await act(async () =>
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    ),
  );
  expect(document.activeElement?.getAttribute("data-board-item")).toBe("task-999");
  expect(node.querySelectorAll("[data-board-item]").length).toBeLessThanOrEqual(12);
});
