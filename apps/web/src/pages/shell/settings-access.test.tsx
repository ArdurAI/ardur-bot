// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button {...props} />
    ),
    Popover: Container,
    PopoverContent: Container,
    PopoverTrigger: ({ children, ...props }: ComponentProps<"button">) => (
      <button {...props}>{children}</button>
    ),
    DropdownMenu: Container,
    DropdownMenuContent: Container,
    DropdownMenuSub: Container,
    DropdownMenuSubContent: Container,
    DropdownMenuSubTrigger: Container,
    DropdownMenuTrigger: () => null,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({
      variant: _variant,
      ...props
    }: ComponentProps<"button"> & { variant?: string }) => <button {...props} />,
  };
});

import { useAppShortcuts } from "../../lib/app-shortcuts";
import { BotContextMenu } from "../BotContextMenu";
import { DashboardAccountArea } from "../dashboard/DashboardAccountArea";
import { SettingsSupportLinks } from "../settings-support-links";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("opens Settings from its persistent entry or the platform shortcut and cleans up", async () => {
  const open = vi.fn();
  // Node has its own navigator beside jsdom's; Control is the modifier off Apple platforms.
  const navigators = new Set([window.navigator, globalThis.navigator]);
  for (const nav of navigators)
    Object.defineProperty(nav, "platform", { value: "Win32", configurable: true });
  function Access() {
    useAppShortcuts({ settings: open });
    return (
      <DashboardAccountArea
        name="Test Owner"
        menuOpen={false}
        onMenuOpenChange={() => undefined}
        onSettings={open}
        onIntegrations={() => undefined}
        onUsage={() => undefined}
        onSignOut={() => undefined}
      />
    );
  }
  await act(async () => root.render(<Access />));
  const settings = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Settings",
  );
  expect(settings).toBeDefined();
  await act(async () => settings?.click());
  const event = new KeyboardEvent("keydown", { key: ",", ctrlKey: true, cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(open).toHaveBeenCalledTimes(2);
  for (const options of [
    {},
    { metaKey: true },
    { ctrlKey: true, altKey: true },
    { ctrlKey: true, repeat: true },
    { ctrlKey: true, isComposing: true },
  ])
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ...options }));
  expect(open).toHaveBeenCalledTimes(2);
  await act(async () => root.render(null));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true }));
  expect(open).toHaveBeenCalledTimes(2);
  for (const nav of navigators) delete (nav as { platform?: string }).platform;
});

it("links to project support in an external browsing context", async () => {
  await act(async () => root.render(<SettingsSupportLinks />));
  const links = [...container.querySelectorAll("a")];
  expect(links.map((link) => [link.textContent, link.href])).toEqual([
    ["Report an issue", "https://github.com/ArdurAI/ardur-bot/issues/new/choose"],
    ["Discussions", "https://github.com/ArdurAI/ardur-bot/discussions"],
  ]);
  for (const link of links) {
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  }
});

it("keeps bot settings and model focus as distinct context-menu actions", async () => {
  const edit = vi.fn();
  const focus = vi.fn();
  const noop = () => undefined;
  await act(async () =>
    root.render(
      <BotContextMenu
        bot={{ name: "Test bot", pinned: false, sectionId: null, unread: false }}
        position={{ x: 0, y: 0 }}
        sections={[]}
        onClose={noop}
        onTogglePinned={noop}
        onMoveToSection={noop}
        onCreateSection={noop}
        onToggleUnread={noop}
        onEdit={edit}
        onModelEffort={focus}
        onDuplicate={noop}
        onClear={noop}
        onArchive={noop}
        onDelete={noop}
      />,
    ),
  );
  const buttons = [...container.querySelectorAll("button")];
  await act(async () => buttons.find((button) => button.textContent === "Bot settings")?.click());
  expect(edit).toHaveBeenCalledOnce();
  expect(focus).not.toHaveBeenCalled();
  await act(async () => buttons.find((button) => button.textContent === "Model & effort")?.click());
  expect(focus).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("Edit Profile");
});
