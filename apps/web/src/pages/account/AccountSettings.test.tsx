// @vitest-environment jsdom
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
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, i) => text + part + (values[i] ?? ""), "");
  return { useLingui: () => ({ t, i18n: { locale: "en" } }) };
});
vi.mock("@ardurbot/ui-web", () => {
  const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
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
