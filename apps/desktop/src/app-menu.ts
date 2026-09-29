import type { AppShortcutId } from "@ardurbot/contracts/app-shortcuts";
import { appShortcutAccelerator } from "@ardurbot/contracts/app-shortcuts";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";

export const APP_SHORTCUT_CHANNEL = "desktop.shortcuts.run";

const LABELS: Record<AppShortcutId, string> = {
  commandPalette: "Switch Bot…",
  newBot: "New Bot",
  focusMessage: "Message",
  find: "Search",
  toggleSidebar: "Show or Hide Bots",
  back: "Back",
  forward: "Forward",
  settings: "Settings…",
};

/**
 * The page handles app shortcut keys itself, so Windows and Linux only show the accelerator.
 * macOS always registers menu keys; it receives only the ones the page leaves alone, such as
 * keys pressed in the terminal, and the page then applies its own rules to the request.
 */
export function appShortcutMenuItem(
  id: AppShortcutId,
  platform: NodeJS.Platform,
  run: (id: AppShortcutId) => void,
): MenuItemConstructorOptions {
  return {
    id: `app-shortcut-${id}`,
    label: LABELS[id],
    accelerator: appShortcutAccelerator(id),
    ...(platform === "darwin" ? {} : { registerAccelerator: false }),
    click: () => run(id),
  };
}

/** Brings the app window forward and runs the shortcut there, as its keys would. */
export function runAppShortcut(
  window: Pick<
    BrowserWindow,
    "isDestroyed" | "isMinimized" | "restore" | "show" | "focus" | "webContents"
  > | null,
  id: AppShortcutId,
) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send(APP_SHORTCUT_CHANNEL, id);
}

export function applicationMenuTemplate(
  platform: NodeJS.Platform,
  server: {
    localSettings: MenuItemConstructorOptions;
    changeServer: MenuItemConstructorOptions;
    stopStack: MenuItemConstructorOptions;
  },
  run: (id: AppShortcutId) => void,
): MenuItemConstructorOptions[] {
  const item = (id: AppShortcutId) => appShortcutMenuItem(id, platform, run);
  const settings = [item("settings"), server.localSettings, server.changeServer, server.stopStack];
  const app: MenuItemConstructorOptions[] = [
    { role: "editMenu" },
    { label: "View", submenu: [item("toggleSidebar")] },
    {
      label: "Go",
      submenu: [
        item("commandPalette"),
        item("find"),
        item("focusMessage"),
        { type: "separator" },
        item("back"),
        item("forward"),
      ],
    },
    { role: "windowMenu" },
  ];
  if (platform === "darwin")
    return [
      {
        label: "Ardur",
        submenu: [
          { role: "about", label: "About Ardur" },
          { type: "separator" },
          ...settings,
          { type: "separator" },
          { role: "hide", label: "Hide Ardur" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: "Quit Ardur" },
        ],
      },
      { label: "File", submenu: [item("newBot")] },
      ...app,
    ];
  return [
    {
      label: "File",
      submenu: [
        item("newBot"),
        { type: "separator" },
        ...settings,
        { type: "separator" },
        { role: "quit" },
      ],
    },
    ...app,
  ];
}
