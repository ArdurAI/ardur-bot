// @vitest-environment jsdom

import type { WorkItem } from "@ardurbot/contracts/board";
import { BoardViewSchema, WorkItemSchema } from "@ardurbot/contracts/board";
import type { ReactNode } from "react";
import { act, createElement as h, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BoardScreen from "../app/board";
import BoardsSettings from "../app/boards-settings";
import FilesScreen from "../app/ide";
import { MobileBoard } from "../components/board-view";
import { rpc } from "./api";

const fakes = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  setParams: vi.fn(),
  push: vi.fn(),
  paired: false,
  pairing: vi.fn(),
  requestClose: undefined as (() => void) | undefined,
  alert: vi.fn(),
  save: vi.fn(),
}));
vi.mock("./api", () => ({ rpc: vi.fn(), selectedSpaceId: () => "space" }));
vi.mock("./dispatch", () => ({ hasPairedDevice: () => fakes.pairing() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: fakes.save.mockResolvedValue(undefined),
}));
const translate = (text: string) => text;
vi.mock("./i18n", () => ({ useI18n: () => ({ t: translate }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  Redirect: ({ href }: { href: unknown }) => h("output", null, JSON.stringify(href)),
  useLocalSearchParams: () => fakes.params,
  useRouter: () => ({ setParams: fakes.setParams, push: fakes.push }),
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  AppState: { currentState: "active" },
  Alert: { alert: fakes.alert },
  ActivityIndicator: () => h("span", null, "Loading"),
  View: ({ children }: { children: ReactNode }) => h("div", null, children),
  ScrollView: ({ children }: { children: ReactNode }) => h("div", null, children),
  Text: ({ children }: { children: ReactNode }) => h("span", null, children),
  Modal: ({
    visible,
    children,
    onRequestClose,
  }: {
    visible: boolean;
    children: ReactNode;
    onRequestClose?: () => void;
  }) => {
    fakes.requestClose = onRequestClose;
    return visible ? h("div", { role: "dialog" }, children) : null;
  },
  Button: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
  }) => h("button", { type: "button", onClick: onPress, disabled }, title),
  Switch: ({
    value,
    onValueChange,
    accessibilityLabel,
  }: {
    value: boolean;
    onValueChange: (v: boolean) => void;
    accessibilityLabel: string;
  }) =>
    h("input", {
      type: "checkbox",
      checked: value,
      "aria-label": accessibilityLabel,
      onChange: () => onValueChange(!value),
    }),
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (v: string) => void;
    accessibilityLabel: string;
  }) =>
    h("input", {
      value,
      "aria-label": accessibilityLabel,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value),
    }),
  FlatList: ({
    data,
    renderItem,
  }: {
    data: WorkItem[];
    renderItem: (value: { item: WorkItem }) => ReactNode;
  }) =>
    h(
      "div",
      null,
      data.map((item) => h("div", { key: item.id }, renderItem({ item }))),
    ),
}));
const item = WorkItemSchema.parse({
  id: "work-a",
  title: "Ready work",
  description: "Item description",
  acceptanceCriteria: "Verify results",
  type: "task",
  status: "open",
  priority: 1,
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
});
const board = BoardViewSchema.parse({
  workspaces: [
    {
      id: "workspace",
      kind: "space",
      name: "Board",
      path: "/fixture/board",
      prefix: "board",
      enabled: true,
      initialized: true,
    },
  ],
  workspaceId: "workspace",
  snapshot: { items: [item], readyIds: [item.id], blockedIds: [] },
  selected: null,
  followingIds: [],
  bots: [],
  problem: null,
});
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  fakes.params = {};
  fakes.paired = false;
  fakes.pairing.mockReset().mockImplementation(async () => fakes.paired);
  vi.mocked(rpc).mockImplementation(async (procedure) =>
    procedure === "board/view"
      ? board
      : procedure === "me"
        ? { isDeploymentOwner: true }
        : procedure === "bots/list"
          ? []
          : procedure === "board/workspaces"
            ? { workspaces: board.workspaces, problem: null }
            : item,
  );
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.useRealTimers();
});
const button = (title: string) =>
  [...node.querySelectorAll("button")].find((button) => button.textContent === title)!;
it("preserves legacy Board item links under Overview", async () => {
  fakes.params = { workspace: "workspace", item: "work-a" };
  await act(async () => root.render(h(BoardScreen)));
  expect(JSON.parse(node.textContent!)).toEqual({
    pathname: "/overview",
    params: { workspace: "workspace", item: "work-a", view: "board" },
  });
});
it("loads the whole board and opens items through the Overview selection", async () => {
  await act(async () => root.render(h(MobileBoard)));
  expect(node.textContent).toContain("Ready work");
  await act(async () => button("Ready work").click());
  expect(fakes.setParams).toHaveBeenCalledWith({
    view: "board",
    workspace: "workspace",
    item: "work-a",
  });
  expect(
    vi.mocked(rpc).mock.calls.filter(([procedure]) => procedure === "board/view"),
  ).toHaveLength(1);
});
it("follows and changes status through the shared authorized RPCs", async () => {
  vi.mocked(rpc).mockImplementation(async (procedure) =>
    procedure === "board/view" ? { ...board, selected: item } : item,
  );
  await act(async () => root.render(h(MobileBoard)));
  await act(async () => button("Follow").click());
  expect(rpc).toHaveBeenCalledWith("board/follow", {
    workspaceId: "workspace",
    id: "work-a",
    following: true,
  });
  const blocked = [...node.querySelectorAll('[role="dialog"] button')].find(
    (button) => button.textContent === "Blocked",
  )!;
  await act(async () => (blocked as HTMLButtonElement).click());
  expect(rpc).toHaveBeenCalledWith("board/update", {
    workspaceId: "workspace",
    id: "work-a",
    patch: { status: "blocked", deferUntil: null },
  });
  expect(node.textContent).toContain("Undo");
});
it("keeps signed read-only device grants read-only", async () => {
  fakes.paired = true;
  vi.mocked(rpc).mockResolvedValue({ ...board, selected: item });
  await act(async () => root.render(h(MobileBoard)));
  expect(node.textContent).toContain("Sign in to manage boards.");
  expect(node.textContent).not.toContain("Follow");
  expect(node.textContent).not.toContain("Send to bot");
});
it("never overlaps a slow summary request", async () => {
  vi.useFakeTimers();
  vi.mocked(rpc).mockImplementation(() => new Promise(() => undefined));
  await act(async () => root.render(h(MobileBoard)));
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(rpc).toHaveBeenCalledTimes(1);
});
it("configures boards in Settings and confirms archiving before mutation", async () => {
  await act(async () => root.render(h(BoardsSettings)));
  expect(node.textContent).toContain("Make default");
  await act(async () => button("Archive board").click());
  expect(vi.mocked(rpc).mock.calls.some(([procedure]) => procedure === "board/configure")).toBe(
    false,
  );
  expect(fakes.alert).toHaveBeenCalledWith(
    "Archive board?",
    "Board files will be kept.",
    expect.any(Array),
  );
  await act(async () => fakes.alert.mock.calls.at(-1)![2][1].onPress());
  expect(rpc).toHaveBeenCalledWith("board/configure", {
    workspaceId: "workspace",
    patch: { enabled: false },
  });
});
async function type(label: string, value: string) {
  const input = node.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("quick-adds in the chosen column and persists local filters without fetching again", async () => {
  await act(async () => root.render(h(MobileBoard)));
  await act(async () => button("Blocked").click());
  await type("New item", "Next work");
  await act(async () => button("Add").click());
  expect(rpc).toHaveBeenCalledWith("board/create", {
    workspaceId: "workspace",
    item: { title: "Next work", type: "task", priority: 2 },
  });
  expect(rpc).toHaveBeenCalledWith("board/update", {
    workspaceId: "workspace",
    id: item.id,
    patch: { status: "blocked" },
  });
  const count = vi.mocked(rpc).mock.calls.length;
  await type("Search", "missing");
  expect(fakes.save).toHaveBeenLastCalledWith(
    "ardurbot.board-filters.space",
    expect.stringContaining('"text":"missing"'),
  );
  expect(rpc).toHaveBeenCalledTimes(count);
});
it("rolls back a failed status change and posts comments through the shared service", async () => {
  vi.mocked(rpc).mockImplementation(async (procedure) => {
    if (procedure === "board/update") throw new Error("unavailable");
    return procedure === "board/view" ? { ...board, selected: item } : item;
  });
  await act(async () => root.render(h(MobileBoard)));
  const blocked = [...node.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent === "Blocked",
  )!;
  await act(async () => blocked.click());
  expect(node.textContent).toContain("Could not load Board; retry.");
  expect(node.textContent).not.toContain("Undo");
  expect(button("Ready work")).toBeDefined();
  await type("Comment", "Checked the work");
  await act(async () => button("Comment").click());
  expect(rpc).toHaveBeenCalledWith("board/comment", {
    workspaceId: "workspace",
    id: item.id,
    text: "Checked the work",
  });
});
it("offers native read-only file browsing through the existing IDE authorization", async () => {
  vi.mocked(rpc).mockImplementation(async (procedure) => {
    if (procedure === "ide/roots") return [{ id: "root", name: "Project" }];
    if (procedure === "ide/list") return { entries: [{ path: "README.md", kind: "file" }] };
    if (procedure === "ide/read") return { content: "Project notes", binary: false };
    throw new Error(`Unexpected procedure: ${procedure}`);
  });
  await act(async () => root.render(h(FilesScreen)));
  await act(async () => button("README.md").click());
  expect(rpc).toHaveBeenCalledWith("ide/read", { rootId: "root", path: "README.md" });
  expect(node.textContent).toContain("Project notes");
  expect(node.textContent).toContain("Open the IDE on desktop to edit.");
});
it("explains Files access on paired phones without attempting account-only IDE requests", async () => {
  fakes.paired = true;
  await act(async () => root.render(h(FilesScreen)));
  expect(node.textContent).toContain("Sign in to browse files.");
  expect(rpc).not.toHaveBeenCalled();
});
it("clears a created quick-add even if its subsequent status change fails", async () => {
  vi.mocked(rpc).mockImplementation(async (procedure) => {
    if (procedure === "board/update") throw new Error("unavailable");
    return procedure === "board/view" ? board : item;
  });
  await act(async () => root.render(h(MobileBoard)));
  await act(async () => button("Blocked").click());
  await type("New item", "Next work");
  await act(async () => button("Add").click());
  expect(node.querySelector<HTMLInputElement>('[aria-label="New item"]')!.value).toBe("");
  expect(button("Add").disabled).toBe(true);
  expect(node.textContent).toContain("Could not load Board; retry.");
  expect(
    vi.mocked(rpc).mock.calls.filter(([procedure]) => procedure === "board/create"),
  ).toHaveLength(1);
});
it.each(["Close", "Android Back"])(
  "dismisses the selection immediately with %s while offline",
  async (action) => {
    fakes.params = { workspace: "workspace", item: item.id };
    vi.mocked(rpc)
      .mockResolvedValueOnce({ ...board, selected: item })
      .mockRejectedValue(new Error("offline"));
    await act(async () => root.render(h(MobileBoard)));
    expect(node.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => (action === "Close" ? button("Close").click() : fakes.requestClose!()));
    expect(node.querySelector('[role="dialog"]')).toBeNull();
    expect(fakes.setParams).toHaveBeenCalledWith(expect.objectContaining({ item: "" }));
  },
);
it.each(["Blocked", "Follow", "Comment", "Builder"])(
  "shows a failed %s action and recovery inside the native sheet",
  async (action) => {
    vi.mocked(rpc).mockImplementation(async (procedure) => {
      if (procedure === "board/view")
        return { ...board, selected: item, bots: [{ id: "builder", name: "Builder" }] };
      throw new Error("offline");
    });
    await act(async () => root.render(h(MobileBoard)));
    if (action === "Comment") await type("Comment", "Check this");
    const target = [...node.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === action,
    )!;
    await act(async () => target.click());
    const sheet = node.querySelector('[role="dialog"]')!;
    expect(sheet.textContent).toContain("Could not load Board; retry.");
    const retry = [...sheet.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    const before = vi
      .mocked(rpc)
      .mock.calls.filter(([procedure]) => procedure === "board/view").length;
    await act(async () => retry!.click());
    expect(
      vi.mocked(rpc).mock.calls.filter(([procedure]) => procedure === "board/view"),
    ).toHaveLength(before + 1);
  },
);
it("drops unavailable bot IDs when editing the mobile board allowlist", async () => {
  vi.mocked(rpc).mockImplementation(async (procedure) => {
    if (procedure === "me") return { isDeploymentOwner: true };
    if (procedure === "bots/list") return [{ id: "builder", name: "Builder" }];
    if (procedure === "board/workspaces")
      return {
        workspaces: [
          { ...board.workspaces[0], allowAllBots: false, allowedBotIds: ["archived", "deleted"] },
        ],
        problem: null,
      };
    return {};
  });
  await act(async () => root.render(h(BoardsSettings)));
  await act(async () => node.querySelector<HTMLInputElement>('[aria-label="Builder"]')!.click());
  expect(rpc).toHaveBeenCalledWith("board/configure", {
    workspaceId: "workspace",
    patch: { allowedBotIds: ["builder"] },
  });
});
it.each(["me", "paired-device"])(
  "retries ownership bootstrap after the initial %s check fails",
  async (failure) => {
    if (failure === "me") vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
    else fakes.pairing.mockRejectedValueOnce(new Error("offline"));
    await act(async () => root.render(h(BoardsSettings)));
    expect(node.textContent).toContain("Could not load Board; retry.");
    await act(async () => button("Retry").click());
    expect(node.textContent).toContain("Make default");
    expect(node.textContent).not.toContain("Could not load Board; retry.");
  },
);
