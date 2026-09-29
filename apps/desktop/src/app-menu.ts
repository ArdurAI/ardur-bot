import type { AppShortcutId } from "@ardurbot/contracts/app-shortcuts";
import {
  APP_SHORTCUTS,
  appShortcutAccelerator,
  appShortcutsEnabled,
} from "@ardurbot/contracts/app-shortcuts";
import type { BrowserWindow, MenuItemConstructorOptions, WebContents } from "electron";

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
 * macOS always registers menu keys. The page refuses a request while the terminal is focused.
 * On the IDE page these items are turned off, so indent and the editor keep the key.
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

/**
 * Runs the shortcut in the app window, bringing it forward as its keys would. It does nothing
 * while another Ardur window (the sign-in pop-up, Local Server Settings, setup) has focus.
 */
export function runAppShortcut(
  window: Pick<
    BrowserWindow,
    "isDestroyed" | "isMinimized" | "restore" | "show" | "focus" | "webContents"
  > | null,
  id: AppShortcutId,
  focused: unknown = null,
) {
  if (!window || window.isDestroyed()) return;
  if (focused !== null && focused !== window) return;
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

export { appShortcutsEnabled };

type AppShortcutMenu = {
  getMenuItemById(id: string): { enabled: boolean } | null;
};

export function applyAppShortcutMenu(menu: AppShortcutMenu, url: string) {
  const enabled = appShortcutsEnabled(url);
  for (const shortcut of APP_SHORTCUTS) {
    const item = menu.getMenuItemById(`app-shortcut-${shortcut.id}`);
    if (item) item.enabled = enabled;
  }
}

/**
 * Keeps the shared menu in step with the main window. A hidden window from a server switch
 * must not change it, and a frame inside the page must not either.
 */
export function watchAppShortcutMenu(
  contents: WebContents,
  getMenu: () => AppShortcutMenu | null,
  isActive: () => boolean = () => true,
) {
  const apply = (url: string) => {
    if (!isActive()) return;
    const menu = getMenu();
    if (menu) applyAppShortcutMenu(menu, url);
  };
  contents.on("did-navigate", (_event, url) => apply(url));
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame === false) return;
    apply(url);
  });
  contents.on("did-finish-load", () => apply(contents.getURL()));
}
