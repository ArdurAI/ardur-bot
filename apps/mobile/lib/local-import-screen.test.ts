// @vitest-environment jsdom

import {
  localImportFixture,
  localImportServerFixture,
  localImportStatusFixture,
} from "@ardurbot/testkit/local-import-fixtures";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import LocalImport from "../app/import";

const fake = vi.hoisted(() => ({
  status: vi.fn(),
  run: vi.fn(),
  configure: vi.fn(),
  servers: vi.fn(),
  credentials: vi.fn(),
}));
vi.mock("./local-import", () => ({ localImport: fake }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values: Record<string, string | number> = {}) =>
      text.replace(/\{(\w+)\}/g, (_, key) => String(values[key])),
  }),
}));
vi.mock("./native", () => ({ native: {}, useThemedStyles: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
const container = ({ children }: { children: ReactNode }) => createElement("div", null, children);
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (value: unknown) => value },
  ActivityIndicator: () => null,
  View: ({ children }: { children: ReactNode }) => container({ children }),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  ScrollView: ({ children }: { children: ReactNode }) => container({ children }),
  TextInput: ({
    value,
    onChangeText,
    secureTextEntry,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    secureTextEntry?: boolean;
    accessibilityLabel?: string;
  }) =>
    createElement("input", {
      type: secureTextEntry ? "password" : "text",
      value,
      "aria-label": accessibilityLabel,
      onChange: (event) => onChangeText(event.target.value),
    }),
  Button: ({
    title,
    disabled,
    onPress,
  }: {
    title: string;
    disabled?: boolean;
    onPress: () => void;
  }) => createElement("button", { type: "button", disabled, onClick: onPress }, title),
  Switch: ({
    value,
    disabled,
    onValueChange,
    accessibilityLabel,
  }: {
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
    accessibilityLabel: string;
  }) =>
    createElement("input", {
      type: "checkbox",
      role: "switch",
      "aria-label": accessibilityLabel,
      checked: value,
      disabled,
      onChange: () => onValueChange(!value),
    }),
}));
it("renders the host manifest with native category selection, preview, import and undo", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let imported = false;
  fake.status.mockImplementation(async () => ({
    ...localImportStatusFixture,
    importedAt: imported ? "2026-09-24T12:00:00.000Z" : null,
    imported: imported ? [{ tool: "claude-code", count: 2 }] : [],
  }));
  fake.run.mockImplementation(async (action) => {
    if (action.action === "preview")
      return { preview: { item: localImportFixture.items[0], content: "A fixture memory body." } };
    imported = action.action === "import";
    return {
      result: {
        created: imported ? 2 : 0,
        removed: imported ? 0 : 2,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        conflicts: 0,
      },
    };
  });
  const node = document.createElement("div");
  const root = createRoot(node);
  const click = async (text: string) =>
    act(async () => {
      [...node.querySelectorAll("button")].find((button) => button.textContent === text)!.click();
    });
  await act(async () => root.render(createElement(LocalImport)));
  expect(node.textContent).toContain("Found on this Mac");
  expect(node.textContent).toContain("never their sign-ins, tokens or chat history");
  await click("Preview Claude Code Memories");
  await click("build.md");
  expect(node.textContent).toContain("A fixture memory body.");
  await click("Import all");
  expect(fake.run).toHaveBeenLastCalledWith({
    action: "import",
    scanId: localImportFixture.scanId,
    tool: "claude-code",
    categories: ["instructions", "memories", "skills", "servers"],
  });
  expect(
    (node.querySelector('[aria-label="Auto-import changes"]') as HTMLInputElement).checked,
  ).toBe(false);
  await click("Remove imported items from Claude Code");
  expect(fake.run).toHaveBeenLastCalledWith({ action: "undo", tool: "claude-code" });
  await act(async () => root.unmount());
});
it("lets the owner enter imported server credentials using secure native fields", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.status.mockResolvedValue({
    ...localImportStatusFixture,
    importedAt: "2026-09-24T12:00:00.000Z",
    imported: [{ tool: "claude-code", count: 1 }],
  });
  fake.servers.mockResolvedValue([localImportServerFixture]);
  fake.credentials.mockResolvedValue({ ok: true });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const click = async (text: string) =>
    act(async () => {
      [...node.querySelectorAll("button")].find((button) => button.textContent === text)!.click();
    });
  await act(async () => root.render(createElement(LocalImport)));
  await click("Set up servers");
  await click("Set up credentials");
  const input = node.querySelector('input[type="password"]') as HTMLInputElement;
  expect(input.value).toBe("");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "new-native-value",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save credentials");
  expect(fake.credentials).toHaveBeenCalledWith({
    serverId: "imported-server",
    env: { API_KEY: "new-native-value" },
    headers: {},
  });
  expect(node.querySelector('input[type="password"]')).toBeNull();
  await click("Set up credentials");
  expect((node.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
  await act(async () => root.unmount());
  node.remove();
});
