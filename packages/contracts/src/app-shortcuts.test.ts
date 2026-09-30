import { describe, expect, it } from "vitest";
import type { AppShortcutKeys } from "./app-shortcuts.js";
import {
  APP_SHORTCUTS,
  appShortcutAccelerator,
  appShortcutAria,
  appShortcutLabel,
  isAppShortcutId,
  matchAppShortcut,
} from "./app-shortcuts.js";

function keys(partial: Partial<AppShortcutKeys> & Pick<AppShortcutKeys, "key">): AppShortcutKeys {
  return { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...partial };
}

const binding = (shortcut: (typeof APP_SHORTCUTS)[number]) =>
  `mod+${shortcut.shift ? "shift+" : ""}${shortcut.key}`;

/** Keys the app shortcuts must leave alone. `mod` is Command on macOS and Control elsewhere. */
const TAKEN: Record<string, string> = {
  "mod+n": "browsers reserve: new window",
  "mod+shift+n": "browsers reserve: private window",
  "mod+t": "browsers reserve: new tab",
  "mod+shift+t": "browsers reserve: reopen tab",
  "mod+w": "browsers reserve, desktop Window menu: close",
  "mod+shift+w": "browsers reserve: close window",
  "mod+q": "browsers reserve, desktop app menu: quit",
  "mod+shift+p": "Firefox reserves: private window",
  "mod+l": "browser address bar",
  "mod+r": "browser reload",
  "mod+shift+r": "browser hard reload",
  "mod+shift+i": "developer tools",
  "mod+shift+j": "developer console",
  "mod+shift+c": "inspect element",
  "mod+z": "desktop Edit menu: undo",
  "mod+shift+z": "desktop Edit menu: redo",
  "mod+y": "desktop Edit menu: redo on Windows",
  "mod+x": "desktop Edit menu: cut",
  "mod+c": "desktop Edit menu: copy",
  "mod+v": "desktop Edit menu: paste",
  "mod+a": "desktop Edit menu: select all",
  "mod+m": "desktop Window menu: minimize",
  "mod+h": "desktop app menu on macOS: hide",
  "mod+1": "top navigation, bot 1 in the palette",
  "mod+2": "top navigation, bot 2 in the palette",
  "mod+3": "top navigation, bot 3 in the palette",
  "mod+4": "top navigation, bot 4 in the palette",
  "mod+5": "bot 5 in the palette",
  "mod+6": "bot 6 in the palette",
  "mod+7": "bot 7 in the palette",
  "mod+8": "bot 8 in the palette",
  "mod+9": "bot 9 in the palette",
  "mod+u": "attach files from the message box",
  "mod+shift+e": "open or close the workspace panel",
  "mod+shift+k": "desktop menu: Change Ardur Server",
  "mod+shift+v": "desktop voice shortcut choice",
  "mod+d": "desktop dictation shortcut choice",
  "mod+shift+d": "desktop dictation shortcut choice",
  "mod+s": "IDE and workspace files: save",
  "mod+p": "IDE and workspace files: open file",
  "mod+`": "IDE: terminal",
  "mod+shift+a": "IDE: ask",
};

describe("app shortcut keymap", () => {
  it("binds each action once and never two actions to one key", () => {
    const ids = APP_SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
    const bindings = APP_SHORTCUTS.map(binding);
    expect(new Set(bindings).size).toBe(bindings.length);
    const physical = APP_SHORTCUTS.map((shortcut) => `${shortcut.shift}:${shortcut.code}`);
    expect(new Set(physical).size).toBe(physical.length);
  });

  it("leaves browser, desktop menu and existing Ardur keys alone", () => {
    expect(APP_SHORTCUTS.filter((shortcut) => TAKEN[binding(shortcut)])).toEqual([]);
  });

  it("covers the daily actions, and only Back and Forward stay out of text fields", () => {
    expect(APP_SHORTCUTS.map(binding)).toEqual([
      "mod+k",
      "mod+shift+o",
      "mod+shift+m",
      "mod+f",
      "mod+b",
      "mod+[",
      "mod+]",
      "mod+,",
    ]);
    expect(APP_SHORTCUTS.filter((shortcut) => !shortcut.typing).map((s) => s.id)).toEqual([
      "back",
      "forward",
    ]);
  });

  it("leaves Enter and Shift+Enter to the message box", () => {
    for (const apple of [true, false])
      for (const modifiers of [{}, { shiftKey: true }, { metaKey: true }, { ctrlKey: true }])
        expect(matchAppShortcut(keys({ key: "Enter", code: "Enter", ...modifiers }), apple)).toBe(
          undefined,
        );
  });

  it("uses Command on Apple platforms and Control elsewhere", () => {
    for (const shortcut of APP_SHORTCUTS) {
      const pressed = { key: shortcut.key, code: shortcut.code, shiftKey: shortcut.shift };
      expect(matchAppShortcut(keys({ ...pressed, metaKey: true }), true)?.id).toBe(shortcut.id);
      expect(matchAppShortcut(keys({ ...pressed, ctrlKey: true }), false)?.id).toBe(shortcut.id);
      // Control+F, B, K and O move the caret or edit text in macOS text fields.
      expect(matchAppShortcut(keys({ ...pressed, ctrlKey: true }), true)).toBe(undefined);
      expect(matchAppShortcut(keys({ ...pressed, metaKey: true }), false)).toBe(undefined);
      expect(
        matchAppShortcut(keys({ ...pressed, metaKey: true, ctrlKey: true }), true),
      ).toBeUndefined();
      expect(matchAppShortcut(keys({ ...pressed, ctrlKey: true, altKey: true }), false)).toBe(
        undefined,
      );
      expect(matchAppShortcut(keys(pressed), false)).toBe(undefined);
      expect(
        matchAppShortcut(keys({ ...pressed, ctrlKey: true, shiftKey: !shortcut.shift }), false),
      ).toBe(undefined);
    }
  });

  it("matches the letter on Latin layouts and the physical key on others", () => {
    expect(matchAppShortcut(keys({ key: "B", code: "KeyB", ctrlKey: true }), false)?.id).toBe(
      "toggleSidebar",
    );
    // AZERTY: the key labelled A sits where QWERTY has Q; the letter wins.
    expect(matchAppShortcut(keys({ key: "a", code: "KeyQ", ctrlKey: true }), false)).toBe(
      undefined,
    );
    expect(
      matchAppShortcut(keys({ key: "Щ", code: "KeyO", metaKey: true, shiftKey: true }), true)?.id,
    ).toBe("newBot");
    expect(matchAppShortcut(keys({ key: "ü", code: "BracketLeft", metaKey: true }), true)?.id).toBe(
      "back",
    );
    expect(
      matchAppShortcut(keys({ key: "Dead", code: "BracketRight", ctrlKey: true }), false)?.id,
    ).toBe("forward");
  });

  it("formats hints, accessible shortcuts and desktop accelerators per platform", () => {
    expect(appShortcutLabel("newBot", true)).toBe("⇧⌘O");
    expect(appShortcutLabel("newBot", false)).toBe("Ctrl+Shift+O");
    expect(appShortcutLabel("back", true)).toBe("⌘[");
    expect(appShortcutLabel("settings", false)).toBe("Ctrl+,");
    expect(appShortcutAria("focusMessage", true)).toBe("Meta+Shift+M");
    expect(appShortcutAria("find", false)).toBe("Control+F");
    expect(appShortcutAccelerator("toggleSidebar")).toBe("CmdOrCtrl+B");
    expect(appShortcutAccelerator("newBot")).toBe("CmdOrCtrl+Shift+O");
    expect(isAppShortcutId("forward")).toBe(true);
    expect(isAppShortcutId("quit")).toBe(false);
    expect(isAppShortcutId(undefined)).toBe(false);
  });
});
