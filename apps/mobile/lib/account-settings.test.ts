// @vitest-environment jsdom
import type { AccountSession, AccountSettings, LocalDevice } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  rpc: vi.fn(),
  signOut: vi.fn(),
  paired: vi.fn(),
  replace: vi.fn(),
  sheet: vi.fn(),
}));
vi.mock("./api", () => ({ rpc: api.rpc, signOut: api.signOut }));
vi.mock("./dispatch", () => ({ hasPairedDevice: api.paired }));
vi.mock("expo-router", () => ({ useRouter: () => ({ replace: api.replace }) }));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: api.sheet }));
vi.mock("../components/avatar-style", () => ({ useAvatarStyle: () => ({ avatarStyle: "robot" }) }));
vi.mock("./i18n", () => {
  const t = (message: string, values?: Record<string, string | number>) =>
    message.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? key));
  return { useI18n: () => ({ t, locale: "en" }) };
});
vi.mock("./native", () => ({
  useMobileTokens: () => ({
    foreground: "black",
    mutedForeground: "gray",
    border: "gray",
    primary: "black",
    destructive: "red",
  }),
  useResolvedAppearance: () => "light",
}));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    View: box,
    Text: box,
    StyleSheet: { create: (styles: unknown) => styles },
    Alert: { alert: vi.fn() },
    Button: ({
      title,
      onPress,
      disabled,
    }: {
      title: string;
      onPress: () => void;
      disabled?: boolean;
    }) => createElement("button", { type: "button", onClick: onPress, disabled }, title),
    Pressable: ({
      children,
      onPress,
      disabled,
    }: {
      children: ReactNode;
      onPress: () => void;
      disabled?: boolean;
    }) => createElement("button", { type: "button", onClick: onPress, disabled }, children),
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      editable,
      maxLength,
    }: {
      accessibilityLabel: string;
      value: string;
      onChangeText: (value: string) => void;
      editable: boolean;
      maxLength: number;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        value,
        disabled: !editable,
        maxLength,
        onInput: (event: { currentTarget: HTMLInputElement }) =>
          onChangeText(event.currentTarget.value),
        onChange: () => undefined,
      }),
  };
});

import { NativeAccountSettings } from "../components/account-settings";

const accountFixture: AccountSettings = {
  name: "Test operator",
  displayName: "Captain",
  workType: "research",
  avatarStyle: "robot",
  spaceId: "test-space",
  instructions: "Use concise answers.",
  instructionsRevision: 1,
  canEditInstructions: true,
  canManageDevices: true,
  requireTrustedDevices: false,
  desktopAvailable: true,
};
const localDevicesFixture: LocalDevice[] = [
  {
    id: "host",
    kind: "host",
    name: "Test computer",
    platform: "linux",
    createdAt: "2026-09-24T05:00:00.000Z",
    lastSeenAt: null,
    approved: true,
  },
  {
    id: "phone",
    kind: "device",
    name: "Test phone",
    platform: "ios",
    createdAt: "2026-09-24T05:00:00.000Z",
    lastSeenAt: null,
    approved: false,
  },
];
const sessionsFixture: AccountSession[] = Array.from({ length: 14 }, (_, index) => ({
  id: `session-${index}`,
  device: "Safari · iOS",
  current: index === 0,
  createdAt: "2026-09-24T05:00:00.000Z",
  updatedAt: "2026-09-24T06:00:00.000Z",
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.paired.mockResolvedValue(false);
  api.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "account/get") return { ...accountFixture };
    if (procedure === "account/localDevices") return [...localDevicesFixture];
    if (procedure === "account/sessions") return [...sessionsFixture];
    if (procedure === "account/updateProfile") return input;
    if (procedure === "account/updateInstructions") return { revision: 2 };
    return { ok: true };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  )!;
  expect(button).toBeDefined();
  await act(async () => button.click());
}
it("renders editable native fields and saves profile and human instructions", async () => {
  await act(async () => root.render(createElement(NativeAccountSettings)));
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="What should your bots call you?"]',
  )!;
  expect(input.disabled).toBe(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Chief");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save");
  expect(api.rpc).toHaveBeenCalledWith(
    "account/updateProfile",
    expect.objectContaining({ displayName: "Chief" }),
  );
  expect(api.rpc).toHaveBeenCalledWith("account/updateInstructions", {
    instructions: "Use concise answers.",
    revision: 1,
  });
  expect(container.textContent).toContain("Saved");
});
it("renders devices without management controls and paginates sessions with Sign out", async () => {
  await act(async () => root.render(createElement(NativeAccountSettings)));
  expect(container.textContent).toContain("Test computer");
  expect(container.textContent).toContain("Test phone");
  expect(container.textContent).toContain("Needs approval");
  expect(container.textContent).not.toContain("Disconnect");
  expect(container.textContent).toContain("Showing 1–10 of 14");
  await click("Next");
  expect(container.textContent).toContain("Showing 11–14 of 14");
  await click("Sign out");
  expect(api.rpc).toHaveBeenCalledWith("account/revokeSession", { id: "session-10" });
  expect(container.textContent).toContain("Showing 11–13 of 13");
});
it("keeps paired grants read-only and never requests auth sessions with device credentials", async () => {
  api.paired.mockResolvedValue(true);
  await act(async () => root.render(createElement(NativeAccountSettings)));
  expect(container.textContent).toContain("Sign in to edit your profile and manage sessions.");
  expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  expect(api.rpc).not.toHaveBeenCalledWith("account/sessions");
  expect(container.textContent).not.toContain("Log out of all devices");
});
