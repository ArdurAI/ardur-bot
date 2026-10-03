// @vitest-environment jsdom
import { failureCategoryMessage, HERMES_CONTEXT_LIMIT_MESSAGE } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BotSettingsScreen from "../app/bot-settings";
import { rpc } from "./api";
import { activateUiLocale, t } from "./i18n";

const fixture = vi.hoisted(() => ({
  bot: {
    id: "bot",
    name: "Fixture",
    title: "",
    description: "",
    color: "gray",
    computerMode: "dedicated",
    runtimeKind: "pi",
    runtimeExperimental: false,
    modelProvider: null,
    modelId: null,
    modelCredentialId: null,
    thinkingLevel: null,
  },
  actions: [] as { text: string; onPress: () => void }[],
  focus: null as null | ((state: string) => void),
}));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./native", () => ({
  useResolvedAppearance: () => "light",
  useMobileTokens: () => ({
    foreground: "#111",
    mutedForeground: "#666",
    destructive: "#a00",
    primary: "#111",
    primaryForeground: "#fff",
  }),
}));
vi.mock("./message-action-sheet", () => ({
  presentMessageActionSheet: ({ actions }: { actions: typeof fixture.actions }) => {
    fixture.actions = actions;
  },
}));
vi.mock("./learning", () => ({
  loadLearning: async () => ({ pendingCount: 0, appliedThisWeek: 0 }),
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useLocalSearchParams: () => ({ botId: "bot" }),
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/context-section", () => ({ ContextSection: () => null }));
vi.mock("../components/runtime-config-panel", () => ({ RuntimeConfigPanel: () => null }));
vi.mock("../components/computer-mode-picker", () => ({
  ComputerModePicker: ({ onChange }: { onChange: (mode: "team") => void }) =>
    createElement(
      "button",
      { type: "button", onClick: () => onChange("team") },
      "Shared With Team",
    ),
}));
vi.mock("../components/runtime-summary", () => ({
  BotRuntimeSettings: ({ children, runtimeKind }: { children: ReactNode; runtimeKind: string }) =>
    createElement("div", { "data-runtime": runtimeKind }, children),
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      fixture.focus = listener;
      return {
        remove: () => {
          fixture.focus = null;
        },
      };
    },
  },
  ScrollView: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) =>
    createElement("span", { role: accessibilityRole === "alert" ? "alert" : undefined }, children),
  Pressable: ({
    children,
    disabled,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      "button",
      { type: "button", disabled, onClick: onPress, "aria-label": accessibilityLabel },
      children,
    ),
  TextInput: ({ value, onChangeText }: { value: string; onChangeText: (value: string) => void }) =>
    createElement("input", {
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
  Switch: ({
    value,
    onValueChange,
    accessibilityLabel,
  }: {
    value: boolean;
    onValueChange: (value: boolean) => void;
    accessibilityLabel: string;
  }) =>
    createElement("input", {
      type: "checkbox",
      checked: value,
      "aria-label": accessibilityLabel,
      onChange: (event: { target: { checked: boolean } }) => onValueChange(event.target.checked),
    }),
  Linking: { openURL: vi.fn() },
}));
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const api = vi.mocked(rpc);
const saveButton = () =>
  [...node.querySelectorAll("button")].find((button) => button.textContent === t("Save"))!;
async function render() {
  await act(async () => root.render(createElement(BotSettingsScreen)));
}
async function choose(kind: string) {
  await act(async () =>
    [...node.querySelectorAll<HTMLButtonElement>("button")]
      .find((entry) => entry.getAttribute("aria-label") === t("Runs on"))!
      .click(),
  );
  const action = fixture.actions.find(
    (entry) => entry.text === kind || entry.text.startsWith(`${kind} (`),
  )!;
  expect(action).toBeDefined();
  await act(async () => action.onPress());
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  activateUiLocale("en");
  api.mockReset();
  api.mockImplementation(async (procedure) => {
    if (procedure === "bots/get") return fixture.bot;
    if (procedure === "models/validatePin") return { ok: true };
    if (procedure === "me")
      return { defaultModel: "fixture-model", defaultProvider: "openai-compatible" };
    if (procedure === "runtimes/availability") return { available: true, models: [] };
    return [];
  });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  activateUiLocale("en");
});

it.each([
  failureCategoryMessage("experimental-off", { runtime: "Codex", bot: "this bot" }),
  failureCategoryMessage("computer-unsupported", { runtime: "Codex", bot: "this bot" }),
  failureCategoryMessage("destinations-space", { runtime: "Ardur" }),
  failureCategoryMessage("connection-missing", { runtime: "Ardur" }),
  HERMES_CONTEXT_LIMIT_MESSAGE,
])("the phone blocks Save with the exact run sentence: %s", async (message) => {
  const impl = api.getMockImplementation()!;
  api.mockImplementation(async (procedure, input, options) => {
    if (procedure === "models/validatePin") throw { code: "BAD_REQUEST", message };
    return impl(procedure, input, options);
  });
  await render();
  expect(
    [...node.querySelectorAll('[role="alert"]')].some((entry) => entry.textContent === message),
  ).toBe(true);
  expect(saveButton().disabled).toBe(true);
  await act(async () => saveButton().click());
  expect(api.mock.calls.some(([procedure]) => procedure === "bots/update")).toBe(false);
  expect(api).toHaveBeenCalledWith(
    "models/validatePin",
    expect.objectContaining({
      botId: "bot",
      runtimeKind: "pi",
      computerMode: "dedicated",
    }),
  );
});

it.each(["Hermes", "Codex", "Claude Code", "Antigravity"])(
  "the phone visibly enables Experimental for %s and permits undo",
  async (kind) => {
    await render();
    // Runtime names come from the shared contract table.
    await choose(kind);
    const toggle = node.querySelector<HTMLInputElement>('input[aria-label="Experimental"]')!;
    expect(toggle.checked).toBe(true);
    expect(node.textContent).toContain("Experimental turned on for this runtime");
    expect(api.mock.calls.some(([procedure]) => procedure === "computer/configure")).toBe(false);
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(false);
    expect(node.textContent).not.toContain("Experimental turned on for this runtime");
    expect(api).toHaveBeenLastCalledWith(
      "models/validatePin",
      expect.objectContaining({ runtimeExperimental: false }),
    );
  },
);

it("the phone rechecks sharing and when it returns from desktop repair", async () => {
  await render();
  const before = api.mock.calls.filter(([name]) => name === "models/validatePin").length;
  await act(async () =>
    [...node.querySelectorAll("button")].find((b) => b.textContent === "Shared With Team")!.click(),
  );
  expect(api).toHaveBeenCalledWith(
    "models/validatePin",
    expect.objectContaining({ computerMode: "team" }),
  );
  await act(async () => fixture.focus?.("active"));
  expect(api.mock.calls.filter(([name]) => name === "models/validatePin").length).toBeGreaterThan(
    before + 1,
  );
});

it.each(["ru", "zh-CN"] as const)(
  "the phone translates server refusal and adjustment in %s",
  async (locale) => {
    activateUiLocale(locale);
    const message = failureCategoryMessage("computer-unsupported", {
      runtime: "Codex",
      bot: "this bot",
    });
    const impl = api.getMockImplementation()!;
    api.mockImplementation(async (procedure, input, options) => {
      if (procedure === "models/validatePin") throw { code: "BAD_REQUEST", message };
      return impl(procedure, input, options);
    });
    await render();
    expect(node.querySelector('[role="alert"]')!.textContent).not.toBe(message);
    await choose(t("Hermes"));
    expect(node.textContent).toContain(t("Experimental turned on for this runtime"));
  },
);

it("the phone ignores an old success while the changed runtime is still being checked", async () => {
  let oldResolve!: (value: unknown) => void, newResolve!: (value: unknown) => void;
  const old = new Promise((resolve) => {
    oldResolve = resolve;
  });
  const next = new Promise((resolve) => {
    newResolve = resolve;
  });
  const impl = api.getMockImplementation()!;
  let count = 0;
  api.mockImplementation(async (procedure, input, options) => {
    if (procedure === "models/validatePin") return ++count === 1 ? old : next;
    return impl(procedure, input, options);
  });
  await render();
  expect(saveButton().disabled).toBe(true);
  await choose("Hermes");
  await act(async () => oldResolve({ ok: true }));
  expect(saveButton().disabled).toBe(true);
  await act(async () => newResolve({ ok: true }));
  expect(saveButton().disabled).toBe(false);
});
