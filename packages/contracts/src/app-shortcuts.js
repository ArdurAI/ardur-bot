/**
 * App keyboard shortcuts, shared by the web app and the desktop menu so both show and run the
 * same keys. Plain JavaScript on purpose: the packaged desktop app loads compiled JS only (see
 * device-paths.js).
 *
 * Every shortcut uses the platform's primary modifier: Command on Apple platforms, Control
 * elsewhere. `typing` marks the shortcuts that also work from a text field; Back and Forward do
 * not, because leaving the conversation would discard the draft being typed.
 *
 * Send is not listed: Enter sends from the message box and Shift+Enter adds a line, handled by
 * the composer itself.
 */
export const APP_SHORTCUTS = Object.freeze([
  Object.freeze({ id: "commandPalette", key: "k", code: "KeyK", shift: false, typing: true }),
  Object.freeze({ id: "newBot", key: "o", code: "KeyO", shift: true, typing: true }),
  Object.freeze({ id: "focusMessage", key: "m", code: "KeyM", shift: true, typing: true }),
  Object.freeze({ id: "find", key: "f", code: "KeyF", shift: false, typing: true }),
  Object.freeze({ id: "toggleSidebar", key: "b", code: "KeyB", shift: false, typing: true }),
  Object.freeze({ id: "back", key: "[", code: "BracketLeft", shift: false, typing: false }),
  Object.freeze({ id: "forward", key: "]", code: "BracketRight", shift: false, typing: false }),
  Object.freeze({ id: "settings", key: ",", code: "Comma", shift: false, typing: true }),
]);

/** @param {unknown} value */
export function isAppShortcutId(value) {
  return APP_SHORTCUTS.some((shortcut) => shortcut.id === value);
}

/** @param {string} id */
export function appShortcut(id) {
  const shortcut = APP_SHORTCUTS.find((candidate) => candidate.id === id);
  if (!shortcut) throw new Error(`Unknown app shortcut: ${id}`);
  return shortcut;
}

/**
 * @param {{ key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }} event
 * @param {boolean} apple
 */
export function matchAppShortcut(event, apple) {
  const primary = apple ? event.metaKey : event.ctrlKey;
  const other = apple ? event.ctrlKey : event.metaKey;
  if (!primary || other || event.altKey) return undefined;
  // Non-Latin layouts report their own character; fall back to the physical key.
  const latin = /^[\x21-\x7e]$/.test(event.key);
  const key = event.key.toLowerCase();
  return APP_SHORTCUTS.find(
    (shortcut) =>
      shortcut.shift === event.shiftKey &&
      (latin ? shortcut.key === key : shortcut.code === event.code),
  );
}

/**
 * The hint shown beside a command: "⇧⌘O" on Apple platforms, "Ctrl+Shift+O" elsewhere.
 * @param {string} id
 * @param {boolean} apple
 */
export function appShortcutLabel(id, apple) {
  const { key, shift } = appShortcut(id);
  const letter = key.toUpperCase();
  return apple ? `${shift ? "⇧" : ""}⌘${letter}` : `Ctrl+${shift ? "Shift+" : ""}${letter}`;
}

/**
 * The aria-keyshortcuts value for a control the shortcut activates.
 * @param {string} id
 * @param {boolean} apple
 */
export function appShortcutAria(id, apple) {
  const { key, shift } = appShortcut(id);
  return `${apple ? "Meta" : "Control"}+${shift ? "Shift+" : ""}${key.toUpperCase()}`;
}

/**
 * The Electron menu accelerator.
 * @param {string} id
 */
export function appShortcutAccelerator(id) {
  const { key, shift } = appShortcut(id);
  return `CmdOrCtrl+${shift ? "Shift+" : ""}${key.toUpperCase()}`;
}

/**
 * Shell shortcuts stay off on the IDE page so the editor, including indent, receives the key.
 * @param {string} url
 */
export function appShortcutsEnabled(url) {
  try {
    const pathname = new URL(url, "https://ardurbot.local").pathname.replace(/\/+$/, "") || "/";
    return pathname !== "/app/ide";
  } catch {
    return true;
  }
}
