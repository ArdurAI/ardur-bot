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

import { useSettingsShortcut } from "../../lib/use-settings-shortcut";
import { BotContextMenu } from "../BotContextMenu";
import { SettingsSupportLinks } from "../settings-support-links";
import { SidebarSettings } from "./sidebar-settings";

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

it("opens Settings from its persistent entry or either platform shortcut and cleans up", async () => {
  const open = vi.fn();
  function Access() {
    useSettingsShortcut(open);
    return <SidebarSettings onClick={open} />;
  }
  await act(async () => root.render(<Access />));
  expect(container.querySelector("button")?.textContent).toBe("Settings");
  await act(async () => container.querySelector("button")?.click());
  for (const modifier of ["metaKey", "ctrlKey"]) {
    const event = new KeyboardEvent("keydown", { key: ",", [modifier]: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  expect(open).toHaveBeenCalledTimes(3);
  for (const options of [
    {},
    { ctrlKey: true, altKey: true },
    { metaKey: true, repeat: true },
    { ctrlKey: true, isComposing: true },
  ])
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ...options }));
  expect(open).toHaveBeenCalledTimes(3);
  await act(async () => root.render(null));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true }));
  expect(open).toHaveBeenCalledTimes(3);
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
