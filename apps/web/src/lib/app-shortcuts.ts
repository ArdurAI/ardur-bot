import type { AppShortcutId } from "@ardurbot/contracts/app-shortcuts";
import {
  appShortcutAria,
  appShortcutLabel,
  appShortcutsEnabled,
  isAppShortcutId,
  matchAppShortcut,
} from "@ardurbot/contracts/app-shortcuts";
import { useEffect, useRef } from "react";
import { desktopBridge } from "./desktop";

export type AppShortcutHandlers = Partial<Record<AppShortcutId, () => void>>;

export function isApplePlatform() {
  if (typeof navigator === "undefined") return false;
  // platform is deprecated but still the most reliable Apple check in browsers.
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export function shortcutLabel(id: AppShortcutId) {
  return appShortcutLabel(id, isApplePlatform());
}

export function shortcutAria(id: AppShortcutId) {
  return appShortcutAria(id, isApplePlatform());
}

// These have always opened over another dialog; the rest wait until it closes.
const OVER_DIALOGS: ReadonlySet<AppShortcutId> = new Set(["commandPalette", "settings"]);
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isTextField(target: Element) {
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return (
    target instanceof HTMLTextAreaElement ||
    target.closest(
      '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    ) !== null
  );
}

type ShortcutRun = "ran" | "dialog" | "skipped";

/**
 * Runs app shortcuts from the keyboard and from the desktop menu. Handlers that are missing
 * leave the key to the browser, for example Hide bots on a page without the bots list.
 * The terminal refuses every shortcut, so a desktop menu request cannot run one either.
 * A dialog blocks every shortcut except the palette and Settings; Back and Forward still
 * cancel the browser's history keys. A text field keeps its own rule and is unchanged.
 */
export function useAppShortcuts(handlers: AppShortcutHandlers) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const apple = isApplePlatform();
    function run(id: AppShortcutId, focus: Element | null): ShortcutRun {
      const handler = latest.current[id];
      if (!handler) return "skipped";
      // One rule for the keyboard and the desktop menu (`desktop.shortcuts.run`).
      if (focus?.closest("[data-terminal-root]")) return "skipped";
      if (!OVER_DIALOGS.has(id) && focus?.closest('[role="dialog"], [role="alertdialog"]'))
        return "dialog";
      handler();
      return "ran";
    }
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (typeof window !== "undefined" && !appShortcutsEnabled(window.location.href)) return;
      const shortcut = matchAppShortcut(event, apple);
      if (!shortcut) return;
      const target = event.target instanceof Element ? event.target : null;
      const inTerminal = target?.closest("[data-terminal-root]");
      // Swallowed so neither the browser nor the desktop menu leaves the draft.
      // On a Mac the page sees the key first; xterm leaves Command chords unhandled,
      // so the menu then runs, and run() refuses it while the terminal has focus.
      if (!inTerminal && !shortcut.typing && target && isTextField(target)) {
        event.preventDefault();
        return;
      }
      const result = run(shortcut.id, target);
      if (result === "ran") event.preventDefault();
      else if (result === "dialog" && (shortcut.id === "back" || shortcut.id === "forward"))
        event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    const stopMenu = desktopBridge()?.shortcuts?.onRun((id) => {
      if (typeof window !== "undefined" && !appShortcutsEnabled(window.location.href)) return;
      if (isAppShortcutId(id)) run(id, document.activeElement);
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      stopMenu?.();
    };
  }, []);
}
