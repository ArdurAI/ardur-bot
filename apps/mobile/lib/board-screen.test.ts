// @vitest-environment jsdom
import type { WorkItem } from "@ardurbot/contracts/board";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import BoardScreen from "../app/board";
import { loadBoardItem, loadBoardReady, loadBoardWorkspaces } from "./board";

vi.mock("./board", () => ({
  loadBoardWorkspaces: vi.fn(),
  loadBoardReady: vi.fn(),
  loadBoardItem: vi.fn(),
  boardProblemText: () => "Board error",
}));
const translate = (text: string) => text;
vi.mock("./i18n", () => ({ useI18n: () => ({ t: translate }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  ActivityIndicator: () => null,
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  ScrollView: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Button: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, title),
  FlatList: ({
    data,
    renderItem,
  }: {
    data: WorkItem[];
    renderItem: (value: { item: WorkItem }) => ReactNode;
  }) =>
    createElement(
      "div",
      null,
      data.map((item) => createElement("div", { key: item.id }, renderItem({ item }))),
    ),
}));
it("renders Ready and the item detail using only read calls", async () => {
  const item = {
    id: "board-a",
    title: "Ready work",
    description: "Item description",
    acceptanceCriteria: "Verify results",
    priority: 1,
    dependencies: [],
    comments: [],
  } as unknown as WorkItem;
  vi.mocked(loadBoardWorkspaces).mockResolvedValue({
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
    problem: null,
  });
  vi.mocked(loadBoardReady).mockResolvedValue([item]);
  vi.mocked(loadBoardItem).mockResolvedValue(item);
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(BoardScreen)));
  expect(node.textContent).toContain("Ready work");
  await act(async () => node.querySelector("button")!.click());
  expect(loadBoardItem).toHaveBeenCalledWith("workspace", "board-a");
  expect(node.textContent).toContain("Item description");
  expect(node.textContent).toContain("Verify results");
  expect(node.textContent).not.toContain("New item");
  expect(node.textContent).not.toContain("Claim");
  await act(async () => root.unmount());
});
