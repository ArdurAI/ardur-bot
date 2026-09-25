// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
const learningSettings = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc: request }));
vi.mock("./dispatch", () => ({ hasPairedDevice: async () => false }));
vi.mock("./learning", () => ({
  loadLearningSettings: learningSettings,
  enableLearningReview: vi.fn(),
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string | number>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? key)),
  }),
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("expo-router", () => ({ Stack: { Screen: () => null } }));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    StyleSheet: { create: (styles: unknown) => styles },
    ActivityIndicator: () => createElement("span", { "data-loading": true }),
    Alert: { alert: vi.fn() },
    ScrollView: box,
    View: box,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    TextInput: () => createElement("input"),
    Switch: ({ accessibilityLabel, value }: { accessibilityLabel: string; value: boolean }) =>
      createElement("input", {
        type: "checkbox",
        "aria-label": accessibilityLabel,
        checked: value,
        readOnly: true,
      }),
    Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
      createElement("button", { type: "button", onClick: onPress }, title),
  };
});

import BoardsSettings from "../app/boards-settings";

const workspace = {
  id: "space-board",
  kind: "space",
  path: "/board",
  prefix: "board",
  name: "Board",
  enabled: true,
  initialized: true,
  isDefault: true,
  allowAllBots: true,
  allowedBotIds: [],
};
let upkeep: () => Promise<unknown>;
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  upkeep = async () => ({ enabled: false });
  request.mockImplementation(async (procedure: string) => {
    if (procedure === "me") return { isDeploymentOwner: true };
    if (procedure === "board/workspaces") return { workspaces: [workspace], problem: null };
    if (procedure === "bots/list") return [];
    if (procedure === "board/upkeep") return upkeep();
    throw new Error(`Unexpected ${procedure}`);
  });
  learningSettings.mockResolvedValue({
    enabled: true,
    canConfigure: true,
    destination: { modelId: "local-model" },
  });
  node = document.createElement("div");
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.render(createElement("div")));
  await act(async () => root.unmount());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const upkeepSwitch = () =>
  node.querySelector<HTMLInputElement>('[aria-label="Bots keep the board and memory current"]');

it.each(["upkeep", "learning"])(
  "shows a load failure with Retry instead of a default state when the %s read fails",
  async (failing) => {
    if (failing === "upkeep") upkeep = async () => Promise.reject(new Error("offline"));
    else learningSettings.mockRejectedValueOnce(new Error("offline"));
    await act(async () => root.render(createElement(BoardsSettings)));
    expect(node.textContent).toContain("Could not load Board; retry.");
    expect(upkeepSwitch()).toBeNull();
    expect(node.textContent).not.toContain("Learning review is");
    upkeep = async () => ({ enabled: false });
    await act(async () =>
      [...node.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry")!
        .click(),
    );
    expect(node.textContent).not.toContain("Could not load Board; retry.");
    expect(upkeepSwitch()?.checked).toBe(false);
    expect(node.textContent).toContain("Learning review is on");
    expect(node.textContent).toContain("Reviewer: local-model");
  },
);
