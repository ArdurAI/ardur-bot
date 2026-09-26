// @vitest-environment jsdom
import type { TeamRow } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import TeamScreen from "../app/team";
import { acceptTeamTask, loadTeamRows, stopTeamTask } from "./team";

vi.mock("./team", () => ({
  loadTeamRows: vi.fn(),
  acceptTeamTask: vi.fn(),
  stopTeamTask: vi.fn(),
  mobileTeamRow: (row: TeamRow) => ({
    name: row.botName,
    text: "Done — waiting for your OK",
    stop: row.canStop,
    accept: row.canAccept,
  }),
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: vi.fn() }),
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Alert: { alert: vi.fn() },
  ActivityIndicator: () => null,
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Button: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress: () => void;
    disabled: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, title),
  FlatList: ({
    data,
    renderItem,
  }: {
    data: TeamRow[];
    renderItem: (value: { item: TeamRow }) => ReactNode;
  }) =>
    createElement(
      "div",
      null,
      data.map((item) => createElement("div", { key: item.botId }, renderItem({ item }))),
    ),
}));
it("renders the native list and wires both shared task controls", async () => {
  vi.mocked(loadTeamRows).mockResolvedValue({
    rows: [
      { botId: "worker", botName: "Reviewer", state: "completed", canStop: true, canAccept: true },
    ] as TeamRow[],
    hostLabel: "This Mac",
  });
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(TeamScreen)));
  expect(node.textContent).toContain("Reviewer");
  expect(node.textContent).toContain("Done — waiting for your OK");
  const buttons = [...node.querySelectorAll("button")];
  await act(async () => buttons.find((button) => button.textContent === "Stop")!.click());
  expect(stopTeamTask).toHaveBeenCalledWith(expect.objectContaining({ botId: "worker" }));
  await act(async () => buttons.find((button) => button.textContent === "Accept")!.click());
  expect(acceptTeamTask).toHaveBeenCalledWith(expect.objectContaining({ botId: "worker" }));
  await act(async () => root.unmount());
});

it.each([false, true, undefined])(
  "renders the native run effort with evidence %s",
  async (effortAttested) => {
    vi.mocked(loadTeamRows).mockResolvedValue({
      rows: [
        {
          botId: "worker",
          botName: "Reviewer",
          state: "completed",
          canStop: false,
          canAccept: false,
          executing: {
            pin: { runtimeKind: "claude-code", modelId: "claude-opus-5", effort: "high" },
            runtimeInfo: { runtimeKind: "claude-code", effortAttested },
          },
        },
      ] as TeamRow[],
      hostLabel: "This Mac",
    });
    const node = document.createElement("div");
    const root = createRoot(node);
    await act(async () => root.render(createElement(TeamScreen)));
    expect(node.textContent).toContain(
      `claude-opus-5 · high${effortAttested ? "" : " · requested"}`,
    );
    expect(node.textContent?.includes("requested")).toBe(effortAttested !== true);
    await act(async () => root.unmount());
  },
);
