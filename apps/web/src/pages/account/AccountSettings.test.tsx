// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  localDevices: vi.fn(),
  sessions: vi.fn(),
  updateProfile: vi.fn(),
  updateInstructions: vi.fn(),
  approveDevice: vi.fn(),
  disconnectDevice: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  setTrustedDevices: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { account: api } }));
vi.mock("../../lib/auth", () => ({
  authClient: { signOut: vi.fn(), $store: { notify: vi.fn() } },
}));
vi.mock("../../components/ai/primitives", () => ({
  SuccessPop: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("../../components/ApprovalRulesSettings", () => ({ ApprovalRulesSettings: () => null }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, i) => text + part + (values[i] ?? ""), "");
  return {
    Select: (p: any) => <div {...p} />,
    SelectTrigger: (p: any) => <div {...p} />,
    SelectValue: (p: any) => <div {...p} />,
    SelectContent: (p: any) => <div {...p} />,
    SelectItem: (p: any) => <div {...p} />,
    SelectGroup: (p: any) => <div {...p} />,
    SelectLabel: (p: any) => <div {...p} />,
    SelectSeparator: (p: any) => <div {...p} />,
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@ardurbot/ui-web", () => {
  const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: (p: any) => <div {...p} />,
    SelectTrigger: (p: any) => <div {...p} />,
    SelectValue: (p: any) => <div {...p} />,
    SelectContent: (p: any) => <div {...p} />,
    SelectItem: (p: any) => <div {...p} />,
    SelectGroup: (p: any) => <div {...p} />,
    SelectLabel: (p: any) => <div {...p} />,
    SelectSeparator: (p: any) => <div {...p} />,
    Button: ({
      variant: _v,
      size: _s,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Field: box,
    FieldLabel: ({ htmlFor, children, ...props }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor} {...props}>
        {children}
      </label>
    ),
    BotAvatar: () => <span />,
    Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Toggle: ({
      children,
      pressed,
      onPressedChange,
    }: {
      children: ReactNode;
      pressed: boolean;
      onPressedChange: () => void;
    }) => (
      <button type="button" aria-pressed={pressed} onClick={onPressedChange}>
        {children}
      </button>
    ),
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: {
      checked: boolean;
      onCheckedChange: (v: boolean) => void;
    }) => (
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
        {...props}
      />
    ),
    AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogContent: box,
    AlertDialogTitle: box,
    AlertDialogDescription: box,
    DropdownMenu: box,
    DropdownMenuContent: box,
    DropdownMenuTrigger: () => <button type="button">Session actions</button>,
    DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  };
});

import { AccountSettings } from "./AccountSettings";
import { ActiveSessionsTable, LocalDevicesTable } from "./AccountTables";
import { accountFixture, localDevicesFixture, sessionsFixture } from "./account-fixtures";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.get.mockResolvedValue({ ...accountFixture });
  api.localDevices.mockResolvedValue([...localDevicesFixture]);
  api.sessions.mockResolvedValue([...sessionsFixture]);
  api.updateProfile.mockImplementation(async (input) => input);
  api.updateInstructions.mockResolvedValue({ revision: 2 });
  api.revokeSession.mockResolvedValue({ ok: true });
  api.revokeOtherSessions.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.ardurbotDesktop;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function click(text: string, parent: ParentNode = container) {
  const button = [...parent.querySelectorAll("button")].find((node) => node.textContent === text)!;
  expect(button).toBeDefined();
  await act(async () => button.click());
}
it("renders registered host and paired-device fixtures with an exact current-desktop badge", async () => {
  await act(async () =>
    root.render(
      <LocalDevicesTable
        devices={localDevicesFixture}
        currentRegistrationId="host-generation"
        canManage
        busy={false}
        onApprove={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    ),
  );
  const rows = container.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain("This computer");
  expect(rows[1]!.textContent).toContain("Needs approval");
  await act(async () =>
    root.render(
      <LocalDevicesTable
        devices={localDevicesFixture}
        currentRegistrationId="stale-generation"
        canManage={false}
        busy={false}
        onApprove={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).not.toContain("This computer");
  expect(container.textContent).not.toContain("Disconnect");
});
it("paginates ten sessions and revokes the selected row on the second page", async () => {
  const revoke = vi.fn();
  await act(async () =>
    root.render(<ActiveSessionsTable sessions={sessionsFixture} busy={false} onRevoke={revoke} />),
  );
  expect(container.querySelectorAll("tbody tr")).toHaveLength(10);
  expect(container.textContent).toContain("Showing 1–10 of 14");
  expect(container.textContent).toContain("Current");
  expect(container.textContent).not.toContain("Location");
  await click("Next");
  expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
  expect(container.textContent).toContain("Showing 11–14 of 14");
  await click("Sign out");
  expect(revoke).toHaveBeenCalledWith(sessionsFixture[10]);
  await act(async () =>
    root.render(
      <ActiveSessionsTable
        sessions={sessionsFixture.slice(0, 10)}
        busy={false}
        onRevoke={revoke}
      />,
    ),
  );
  expect(container.textContent).toContain("Showing 1–10 of 10");
});
it("keeps trust off without a desktop and confirms revoking only other sessions", async () => {
  api.get.mockResolvedValue({ ...accountFixture, desktopAvailable: false });
  await act(async () => root.render(<AccountSettings />));
  const toggle = container.querySelector<HTMLInputElement>("#account-trusted-devices")!;
  expect(toggle.disabled).toBe(true);
  expect(toggle.checked).toBe(false);
  expect(container.textContent).toContain("Connect a desktop app to approve new devices.");
  await click("Log out");
  expect(api.revokeOtherSessions).not.toHaveBeenCalled();
  const dialog = container.querySelector("[role=alertdialog]")!;
  expect(dialog.textContent).toContain("keeps this one signed in");
  await click("Log out", dialog);
  expect(api.revokeOtherSessions).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Showing 1–1 of 1");
  expect(container.textContent).toContain("Current");
});
it("saves bounded profile and instructions through separate actions", async () => {
  await act(async () => root.render(<AccountSettings />));
  const forms = container.querySelectorAll("form");
  await act(async () =>
    forms[0]!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(api.updateProfile).toHaveBeenCalledWith({
    name: "Test operator",
    displayName: "Captain",
    workType: "research",
    avatarStyle: "robot",
  });
  expect(api.updateInstructions).not.toHaveBeenCalled();
  await act(async () =>
    forms[1]!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(api.updateInstructions).toHaveBeenCalledWith({
    instructions: "Use concise answers.",
    revision: 1,
  });
  expect(container.querySelector("textarea")!.maxLength).toBe(4000);
});
it("keeps the instructions card visible under the real search stylesheet rule", async () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve("apps/web/src/styles.css"), "utf8");
  document.head.append(style);
  try {
    await act(async () => root.render(<AccountSettings />));
    const group = [...container.querySelectorAll("[data-settings-group]")].find((node) =>
      node.textContent?.includes("Instructions for all bots"),
    );
    expect(group).toBeDefined();
    const row = group!.querySelector<HTMLElement>("[data-settings-row]");
    expect(row?.hidden ?? false).toBe(false);
    // The real rule in styles.css hides a group without a visible row; the
    // instructions card must keep a registered row so it stays on screen.
    expect(getComputedStyle(group!).display, "instructions card is display:none").not.toBe("none");
  } finally {
    style.remove();
  }
});
it("advances the save baseline so editing back stays savable", async () => {
  await act(async () => root.render(<AccountSettings />));
  const saveProfile = () =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === "Save")!;
  const saveInstructions = () =>
    [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Save instructions",
    )!;
  async function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
      const proto =
        node instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  expect(saveProfile().disabled).toBe(true);
  await type(container.querySelector<HTMLInputElement>("input#account-display-name")!, "Chief");
  expect(saveProfile().disabled).toBe(false);
  await act(async () => saveProfile().click());
  expect(saveProfile().disabled, "save stays enabled right after saving").toBe(true);
  await type(container.querySelector<HTMLInputElement>("input#account-display-name")!, "Captain");
  expect(saveProfile().disabled, "editing back to the original value must stay savable").toBe(
    false,
  );

  expect(saveInstructions().disabled).toBe(true);
  await type(
    container.querySelector<HTMLTextAreaElement>("textarea#account-instructions")!,
    "Be terse.",
  );
  expect(saveInstructions().disabled).toBe(false);
  await act(async () => saveInstructions().click());
  expect(saveInstructions().disabled, "instructions save stays enabled right after saving").toBe(
    true,
  );
  await type(
    container.querySelector<HTMLTextAreaElement>("textarea#account-instructions")!,
    "Use concise answers.",
  );
  expect(
    saveInstructions().disabled,
    "editing instructions back to the original text must stay savable",
  ).toBe(false);
});

it("adopts a refreshed account into a clean form and saves the refreshed values", async () => {
  const saveProfile = () =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === "Save")!;
  const saveInstructions = () =>
    [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Save instructions",
    )!;
  async function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
      const proto =
        node instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await act(async () => root.render(<AccountSettings />));
  api.get.mockResolvedValue({
    ...accountFixture,
    name: "Renamed by another session",
    instructions: "Be terse.",
    instructionsRevision: 4,
  });
  // Disconnecting a device refetches the account while this profile stays mounted.
  await click("Disconnect");
  expect(container.querySelector<HTMLInputElement>("input#account-full-name")!.value).toBe(
    "Renamed by another session",
  );
  expect(container.querySelector<HTMLTextAreaElement>("textarea#account-instructions")!.value).toBe(
    "Be terse.",
  );
  expect(saveProfile().disabled, "a clean form stays clean after the refresh").toBe(true);
  expect(saveInstructions().disabled).toBe(true);
  // Saving after a clean refresh submits the refreshed full name, not the stale one.
  await type(container.querySelector<HTMLInputElement>("input#account-display-name")!, "Chief");
  await act(async () => saveProfile().click());
  expect(api.updateProfile).toHaveBeenCalledWith({
    name: "Renamed by another session",
    displayName: "Chief",
    workType: "research",
    avatarStyle: "robot",
  });
  // The instruction revision advances on refresh.
  api.updateInstructions.mockClear();
  await type(
    container.querySelector<HTMLTextAreaElement>("textarea#account-instructions")!,
    "Be very terse.",
  );
  await act(async () => saveInstructions().click());
  expect(api.updateInstructions).toHaveBeenCalledWith({
    instructions: "Be very terse.",
    revision: 4,
  });
});

it("keeps a dirty field across a refresh and never resubmits the stale value", async () => {
  const saveProfile = () =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === "Save")!;
  async function type(node: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await act(async () => root.render(<AccountSettings />));
  await type(container.querySelector<HTMLInputElement>("input#account-display-name")!, "Chief");
  api.get.mockResolvedValue({
    ...accountFixture,
    name: "Renamed by another session",
    displayName: "Captain",
  });
  await click("Disconnect");
  expect(container.querySelector<HTMLInputElement>("input#account-display-name")!.value).toBe(
    "Chief",
  );
  expect(saveProfile().disabled, "the dirty field stays dirty").toBe(false);
  await act(async () => saveProfile().click());
  expect(api.updateProfile).toHaveBeenCalledWith({
    name: "Renamed by another session",
    displayName: "Chief",
    workType: "research",
    avatarStyle: "robot",
  });
});

it("shows a follow-up failure with a Retry that reruns only the follow-up", async () => {
  const onAvatarStyleChange = vi.fn<(style: "robot" | "organic") => Promise<void>>();
  const saveProfile = () =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === "Save")!;
  async function type(node: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await act(async () => root.render(<AccountSettings onAvatarStyleChange={onAvatarStyleChange} />));
  await type(container.querySelector<HTMLInputElement>("input#account-display-name")!, "Chief");
  onAvatarStyleChange.mockRejectedValueOnce(new Error("preferences offline"));
  await act(async () => saveProfile().click());
  expect(api.updateProfile).toHaveBeenCalledTimes(1);
  expect(onAvatarStyleChange).toHaveBeenCalledWith("robot");
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Saved, but not applied everywhere.");
  const retry = [...alert.querySelectorAll("button")].find((node) => node.textContent === "Retry")!;
  expect(retry).toBeDefined();
  expect(saveProfile().disabled, "Save is disabled because the profile itself saved").toBe(true);
  // Retry re-invokes only the follow-up; the profile is not re-submitted.
  onAvatarStyleChange.mockResolvedValueOnce(undefined);
  await act(async () => retry.click());
  expect(onAvatarStyleChange).toHaveBeenCalledTimes(2);
  expect(api.updateProfile).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
