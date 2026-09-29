import type { AppShortcutId } from "@ardurbot/contracts/app-shortcuts";
import {
  appShortcutAria,
  appShortcutLabel,
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

/**
 * Runs app shortcuts from the keyboard and from the desktop menu. Handlers that are missing
 * leave the key to the browser, for example Hide bots on a page without the bots list.
 */
export function useAppShortcuts(handlers: AppShortcutHandlers) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const apple = isApplePlatform();
    function run(id: AppShortcutId, focus: Element | null) {
      const handler = latest.current[id];
      if (!handler) return false;
      if (!OVER_DIALOGS.has(id) && focus?.closest('[role="dialog"], [role="alertdialog"]'))
        return false;
      handler();
      return true;
    }
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      const shortcut = matchAppShortcut(event, apple);
      if (!shortcut) return;
      const target = event.target instanceof Element ? event.target : null;
      // The terminal sends Control keys to the shell.
      if (target?.closest("[data-terminal-root]")) return;
      if (!shortcut.typing && target && isTextField(target)) {
        // Swallowed so neither the browser nor the desktop menu leaves the draft.
        event.preventDefault();
        return;
      }
      if (run(shortcut.id, target)) event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    const stopMenu = desktopBridge()?.shortcuts?.onRun((id) => {
      if (isAppShortcutId(id)) run(id, document.activeElement);
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      stopMenu?.();
    };
  }, []);
}
