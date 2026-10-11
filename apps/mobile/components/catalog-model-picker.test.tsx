// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sheet = vi.hoisted(() => vi.fn());
vi.mock("../lib/message-action-sheet", () => ({ presentMessageActionSheet: sheet }));
vi.mock("../lib/native", () => ({
  native: { label: "black", fill: "white", secondaryLabel: "gray" },
  useMobileTokens: () => ({ foreground: "black", mutedForeground: "gray" }),
  useResolvedAppearance: () => "light",
}));
vi.mock("react-native", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    accessibilityLabel: string;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    accessibilityState: { selected: boolean };
  }) => (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={accessibilityState.selected}
      onClick={onPress}
    >
      {children}
    </button>
  ),
}));

import { CatalogModelPicker } from "./catalog-model-picker";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sheet.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const models = [
  { provider: "first", id: "shared", label: "Shared", billing: "", auth: "api-key" as const },
  {
    provider: "second",
    id: "first/shared",
    label: "Shared",
    billing: "",
    auth: "oauth" as const,
    signIn: "device-code" as const,
  },
  {
    provider: "ollama",
    id: "llama:small",
    label: "Local Llama",
    billing: "",
    credentialId: "local",
  },
];
const credentials = [
  { id: "saved", provider: "first", label: "Saved", hasKey: true, isDefault: false },
  { id: "local", provider: "ollama", label: "Local", hasKey: true, isDefault: false },
];
const props = { catalog: models, credentials, provider: "", modelId: "" };
it("searches across providers and explicitly selects a compatible connection", async () => {
  const onChange = vi.fn();
  await act(async () => root.render(<CatalogModelPicker {...props} onChange={onChange} />));
  expect(container.querySelectorAll("button")).toHaveLength(2);
  expect(container.textContent).toContain("Ready");
  await act(async () => container.querySelector("button")!.click());
  expect(onChange).toHaveBeenLastCalledWith(null);
  const options = sheet.mock.calls[0]![0];
  expect(options.title).toBe("Choose connection");
  expect(options.actions.map((action: { text: string }) => action.text)).toEqual([
    "Saved · Ready",
    "second · Sign in",
  ]);
  await act(async () => options.actions[0].onPress());
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      credential: expect.objectContaining({ id: "saved" }),
      entry: expect.objectContaining({ provider: "first", id: "shared" }),
    }),
  );
});
it("keeps selection empty when the native connection sheet is cancelled", async () => {
  const onChange = vi.fn();
  await act(async () => root.render(<CatalogModelPicker {...props} onChange={onChange} />));
  await act(async () => container.querySelector("button")!.click());
  expect(sheet.mock.calls[0]![0].cancel).toBe("Cancel");
  expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
});
it("finds and selects a local model without any hosted credential", async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <CatalogModelPicker {...props} credentials={[credentials[1]!]} onChange={onChange} />,
    ),
  );
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "llama");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelectorAll("button")).toHaveLength(1);
  await act(async () => container.querySelector("button")!.click());
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      requirement: "ready",
      entry: expect.objectContaining({ provider: "ollama" }),
    }),
  );
  expect(sheet).not.toHaveBeenCalled();
});
