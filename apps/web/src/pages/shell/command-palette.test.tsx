// @vitest-environment jsdom
import type { Bot } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Badge: Box,
    BotAvatar: () => null,
    Command: Box,
    // Base UI reports the end of the closing animation; here it ends at once.
    CommandDialog: ({
      open,
      onOpenChangeComplete,
      children,
    }: {
      open: boolean;
      onOpenChangeComplete?: (open: boolean) => void;
      children: ReactNode;
    }) => {
      useEffect(() => {
        if (!open) onOpenChangeComplete?.(false);
      }, [open, onOpenChangeComplete]);
      return open ? <div role="dialog">{children}</div> : null;
    },
    CommandEmpty: () => null,
    CommandGroup: Box,
    CommandInput: ({
      value,
      onValueChange,
    }: {
      value: string;
      onValueChange: (value: string) => void;
    }) => (
      <input aria-label="Search" value={value} onChange={(e) => onValueChange(e.target.value)} />
    ),
    CommandItem: ({
      children,
      onSelect,
      "data-testid": testId,
    }: {
      children: ReactNode;
      onSelect: () => void;
      "data-testid"?: string;
    }) => (
      <button type="button" data-testid={testId} onClick={onSelect}>
        {children}
      </button>
    ),
    CommandList: Box,
    CommandSeparator: () => <hr />,
    CommandShortcut: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Kbd: ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>,
  };
});

import type { CommandPaletteAction } from "./command-palette";
import { CommandPalette } from "./command-palette";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const navigators = () => new Set([window.navigator, globalThis.navigator]);
const bot = { id: "chief", name: "Chief", title: "", description: "", preview: "" } as Bot;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const nav of navigators()) delete (nav as { platform?: string }).platform;
  vi.unstubAllGlobals();
});

function Palette({
  open,
  onOpenChange,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: CommandPaletteAction[];
}) {
  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      bots={[bot]}
      onSelectBot={() => undefined}
      actions={actions}
    />
  );
}

for (const [platform, hints] of [
  ["MacIntel", ["⌘1", "⇧⌘O", "⌘B", "⌘]", "⌘,"]],
  ["Win32", ["Ctrl+1", "Ctrl+Shift+O", "Ctrl+B", "Ctrl+]", "Ctrl+,"]],
] as const) {
  it(`shows each command's shortcut for ${platform}`, async () => {
    for (const nav of navigators())
      Object.defineProperty(nav, "platform", { value: platform, configurable: true });
    const actions: CommandPaletteAction[] = [
      { id: "newBot", label: "New bot", onSelect: vi.fn() },
      { id: "toggleSidebar", label: "Hide bots", onSelect: vi.fn() },
      { id: "forward", label: "Forward", onSelect: vi.fn() },
      { id: "settings", label: "Settings", onSelect: vi.fn() },
    ];
    await act(async () =>
      root.render(<Palette open onOpenChange={() => undefined} actions={actions} />),
    );
    expect([...container.querySelectorAll("kbd")].map((kbd) => kbd.textContent)).toEqual(hints);
  });
}

it("filters commands with the search and runs one after the palette has closed", async () => {
  const settings = vi.fn();
  const newBot = vi.fn();
  const actions: CommandPaletteAction[] = [
    { id: "newBot", label: "New bot", onSelect: newBot },
    { id: "settings", label: "Settings", onSelect: settings },
  ];
  let open = true;
  const onOpenChange = vi.fn((next: boolean) => {
    open = next;
  });
  const render = () =>
    act(async () =>
      root.render(<Palette open={open} onOpenChange={onOpenChange} actions={actions} />),
    );
  await render();
  const search = container.querySelector("input")!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(search, "sett");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector('[data-testid="command-palette-action-newBot"]')).toBeNull();
  const item = container.querySelector<HTMLButtonElement>(
    '[data-testid="command-palette-action-settings"]',
  )!;
  await act(async () => item.click());
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(settings).not.toHaveBeenCalled();
  await render();
  await act(async () => {
    await Promise.resolve();
  });
  expect(settings).toHaveBeenCalledOnce();
  expect(newBot).not.toHaveBeenCalled();
});
