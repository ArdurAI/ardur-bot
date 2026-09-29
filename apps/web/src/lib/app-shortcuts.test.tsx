// @vitest-environment jsdom
import type { ArdurBotDesktop } from "@ardurbot/contracts";
import type { AppShortcutId } from "@ardurbot/contracts/app-shortcuts";
import { APP_SHORTCUTS, appShortcut } from "@ardurbot/contracts/app-shortcuts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppShortcutHandlers } from "./app-shortcuts";
import { shortcutAria, shortcutLabel, useAppShortcuts } from "./app-shortcuts";

const ids = APP_SHORTCUTS.map((shortcut) => shortcut.id);
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let handlers: Record<AppShortcutId, ReturnType<typeof vi.fn<() => void>>>;

// Node has its own navigator beside jsdom's; set both so the test does not depend on the host.
const navigators = () => new Set([window.navigator, globalThis.navigator]);
function setPlatform(platform: "MacIntel" | "Win32") {
  for (const nav of navigators())
    Object.defineProperty(nav, "platform", { value: platform, configurable: true });
}

function Harness({ only }: { only?: AppShortcutHandlers }) {
  useAppShortcuts(only ?? handlers);
  return (
    <div>
      <input aria-label="Search" />
      <input aria-label="Remember" type="checkbox" />
      <textarea aria-label="Message" />
      <div data-field="Note" contentEditable suppressContentEditableWarning>
        <span>Draft</span>
      </div>
      <div data-terminal-root="">
        <textarea aria-label="Terminal" />
      </div>
      <div role="dialog">
        <input aria-label="Dialog field" />
      </div>
      <div role="alertdialog">
        <button type="button">Confirm</button>
      </div>
    </div>
  );
}

function press(
  target: Element,
  id: AppShortcutId,
  apple: boolean,
  extra: KeyboardEventInit = {},
): KeyboardEvent {
  const { key, code, shift } = appShortcut(id);
  const event = new KeyboardEvent("keydown", {
    key: shift ? key.toUpperCase() : key,
    code,
    shiftKey: shift,
    [apple ? "metaKey" : "ctrlKey"]: true,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  target.dispatchEvent(event);
  return event;
}

const field = (label: string) =>
  container.querySelector(`[aria-label="${label}"], [data-field="${label}"]`)!;
const fired = () => ids.filter((id) => handlers[id].mock.calls.length > 0);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  handlers = Object.fromEntries(ids.map((id) => [id, vi.fn<() => void>()])) as typeof handlers;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const nav of navigators()) delete (nav as { platform?: string }).platform;
  delete window.ardurbotDesktop;
  vi.unstubAllGlobals();
});

describe("useAppShortcuts", () => {
  for (const [platform, apple] of [
    ["MacIntel", true],
    ["Win32", false],
  ] as const) {
    it(`runs every shortcut with the ${apple ? "Command" : "Control"} key`, async () => {
      setPlatform(platform);
      await act(async () => root.render(<Harness />));
      for (const id of ids) {
        const event = press(document.body, id, apple);
        expect(event.defaultPrevented, id).toBe(true);
        expect(handlers[id], id).toHaveBeenCalledOnce();
      }
      for (const id of ids) {
        const { key, code, shift } = appShortcut(id);
        const other = new KeyboardEvent("keydown", {
          key,
          code,
          shiftKey: shift,
          [apple ? "ctrlKey" : "metaKey"]: true,
          bubbles: true,
          cancelable: true,
        });
        document.body.dispatchEvent(other);
        expect(other.defaultPrevented, id).toBe(false);
      }
      expect(ids.every((id) => handlers[id].mock.calls.length === 1)).toBe(true);
      expect(shortcutLabel("newBot")).toBe(apple ? "⇧⌘O" : "Ctrl+Shift+O");
      expect(shortcutAria("find")).toBe(apple ? "Meta+F" : "Control+F");
    });
  }

  it("keeps Back and Forward, and every plain key, out of text fields", async () => {
    setPlatform("Win32");
    await act(async () => root.render(<Harness />));
    for (const label of ["Search", "Message", "Note"]) {
      const target = label === "Note" ? field(label).querySelector("span")! : field(label);
      for (const id of ["back", "forward"] as const) {
        // Swallowed, so neither the browser nor the desktop menu navigates away from a draft.
        expect(press(target, id, false).defaultPrevented, `${label} ${id}`).toBe(true);
      }
      for (const key of ["b", "o", "O", "k", "f", "m", "[", "]", ",", "Enter"]) {
        const typed = new KeyboardEvent("keydown", {
          key,
          shiftKey: key === "O",
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(typed);
        expect(typed.defaultPrevented, `${label} ${key}`).toBe(false);
      }
    }
    expect(fired()).toEqual([]);
    for (const id of ids.filter((id) => appShortcut(id).typing))
      expect(press(field("Message"), id, false).defaultPrevented, id).toBe(true);
    expect(fired()).toEqual(ids.filter((id) => appShortcut(id).typing));
  });

  it("runs Back and Forward from controls that are not text fields", async () => {
    setPlatform("MacIntel");
    await act(async () => root.render(<Harness />));
    press(field("Remember"), "back", true);
    press(field("Remember"), "forward", true);
    expect(fired()).toEqual(["back", "forward"]);
  });

  it("leaves the terminal, dialogs and keys another handler took alone", async () => {
    setPlatform("Win32");
    await act(async () => root.render(<Harness />));
    for (const id of ids) {
      expect(press(field("Terminal"), id, false).defaultPrevented, id).toBe(false);
    }
    expect(fired()).toEqual([]);
    for (const id of ids) press(field("Dialog field"), id, false);
    expect(fired()).toEqual(["commandPalette", "settings"]);
    for (const id of ids) press(container.querySelector('[role="alertdialog"] button')!, id, false);
    expect(ids.filter((id) => handlers[id].mock.calls.length > 1)).toEqual([
      "commandPalette",
      "settings",
    ]);

    const taken = (event: Event) => event.preventDefault();
    field("Message").addEventListener("keydown", taken);
    press(field("Message"), "find", false);
    expect(handlers.find).not.toHaveBeenCalled();
    field("Message").removeEventListener("keydown", taken);

    press(document.body, "find", false, { repeat: true });
    press(document.body, "find", false, { isComposing: true });
    expect(handlers.find).not.toHaveBeenCalled();
  });

  it("leaves keys to the browser when a page has no handler for them", async () => {
    setPlatform("Win32");
    const settings = vi.fn();
    await act(async () => root.render(<Harness only={{ settings }} />));
    expect(press(document.body, "toggleSidebar", false).defaultPrevented).toBe(false);
    expect(press(document.body, "settings", false).defaultPrevented).toBe(true);
    expect(settings).toHaveBeenCalledOnce();
  });

  it("runs desktop menu requests through the same rules and stops listening on unmount", async () => {
    setPlatform("MacIntel");
    let menu: ((id: string) => void) | undefined;
    const stop = vi.fn();
    window.ardurbotDesktop = {
      shortcuts: {
        onRun: (listener: (id: string) => void) => {
          menu = listener;
          return stop;
        },
      },
    } as unknown as ArdurBotDesktop;
    await act(async () => root.render(<Harness />));
    menu!("newBot");
    menu!("quit");
    expect(fired()).toEqual(["newBot"]);
    (field("Dialog field") as HTMLInputElement).focus();
    menu!("toggleSidebar");
    menu!("settings");
    expect(fired()).toEqual(["newBot", "settings"]);
    await act(async () => root.render(null));
    expect(stop).toHaveBeenCalledOnce();
    press(document.body, "newBot", true);
    expect(handlers.newBot).toHaveBeenCalledOnce();
  });

  it("calls the latest handler after a re-render", async () => {
    setPlatform("Win32");
    const first = vi.fn();
    const second = vi.fn();
    await act(async () => root.render(<Harness only={{ find: first }} />));
    await act(async () => root.render(<Harness only={{ find: second }} />));
    press(document.body, "find", false);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
