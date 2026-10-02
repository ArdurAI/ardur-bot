// @vitest-environment jsdom
import type { ComputerUpdate } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  snapshot: { updates: [] as ComputerUpdate[], openId: null as string | null },
  start: vi.fn(async (_botId: string, _action: string) => {}),
  dismiss: vi.fn(async (_id: string) => {}),
}));
vi.mock("./computer-updates", () => ({
  computerUpdates: {
    getSnapshot: () => store.snapshot,
    subscribe: () => () => {},
    watch: () => () => {},
    open: vi.fn(),
    start: store.start,
    dismiss: store.dismiss,
  },
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("expo-router", () => ({ usePathname: () => "/app/bot" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? createElement("section", { "data-testid": "update-sheet" }, children) : null,
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) =>
    createElement("span", { role: accessibilityRole }, children),
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, children),
}));

import { ComputerUpdateProgress } from "../components/computer-update-progress";

const base: ComputerUpdate = {
  id: "update",
  botId: "bot",
  name: "Builder",
  mode: "dedicated",
  action: "update",
  stage: "saving",
  status: "failed",
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function mounted(update: ComputerUpdate, run: (sheet: HTMLElement) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store.snapshot = { updates: [update], openId: update.id };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ComputerUpdateProgress)));
    await run(container.querySelector<HTMLElement>('[data-testid="update-sheet"]')!);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

it.each([
  ["source-not-running", "The computer stopped before its workspace could be saved."],
  ["source-missing", "The computer or its workspace could not be found."],
  ["engine-unreachable", "The computer's engine could not be reached to save its workspace."],
  ["too-large", "The workspace is too large to save."],
  ["save-failed", "The workspace could not be saved."],
])(
  "shows one cause sentence and keeps recovery on phone for %s",
  async (failureReason, sentence) => {
    await mounted({ ...base, failureReason }, async (sheet) => {
      expect([...sheet.querySelectorAll('[role="alert"]')].map((node) => node.textContent)).toEqual(
        [sentence],
      );
      expect(sheet.textContent).not.toContain(failureReason);
      expect(sheet.textContent).not.toContain("Unsaved work may be lost.");
      const recover = [...sheet.querySelectorAll("button")].find(
        (button) => button.textContent === "Recover computer",
      )!;
      expect(recover.disabled).toBe(false);
      await act(async () => recover.click());
      expect(store.start).toHaveBeenCalledExactlyOnceWith(base.botId, "recover");
    });
  },
);

it("preserves missing-engine guidance and hides recovery on phone", async () => {
  const sentence = "This computer's engine is not configured. Reset it in Settings, Computers.";
  await mounted({ ...base, failureReason: sentence }, async (sheet) => {
    expect(sheet.querySelector('[role="alert"]')?.textContent).toBe(sentence);
    expect([...sheet.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Dismiss",
    ]);
  });
});

it("does not offer recovery for an interrupted typed failure on phone", async () => {
  await mounted({ ...base, status: "interrupted", failureReason: "save-failed" }, async (sheet) => {
    expect(sheet.querySelector('[role="alert"]')?.textContent).toBe(
      "Recovery is unavailable until the previous operation has stopped.",
    );
    expect([...sheet.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Continue in Background",
    ]);
  });
});
