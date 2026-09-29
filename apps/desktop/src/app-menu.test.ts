import { readFileSync } from "node:fs";
import type { AppShortcutId } from "@ardurbot/contracts/app-shortcuts";
import { APP_SHORTCUTS } from "@ardurbot/contracts/app-shortcuts";
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  APP_SHORTCUT_CHANNEL,
  applicationMenuTemplate,
  applyAppShortcutMenu,
  appShortcutsEnabled,
  runAppShortcut,
  watchAppShortcutMenu,
} from "./app-menu.js";

const server = {
  localSettings: { id: "local-server-settings", label: "Local Server Settings…" },
  changeServer: {
    id: "change-ardurbot-server",
    label: "Change Ardur Server…",
    accelerator: "CmdOrCtrl+Shift+K",
  },
  stopStack: { id: "stop-local-stack", label: "Stop Local Stack" },
};

/** Accelerators Electron gives the roles this menu uses. */
const ROLE_ACCELERATORS = [
  "CmdOrCtrl+Z",
  "Shift+CmdOrCtrl+Z",
  "CmdOrCtrl+Y",
  "CmdOrCtrl+X",
  "CmdOrCtrl+C",
  "CmdOrCtrl+V",
  "Shift+Alt+CmdOrCtrl+V",
  "CmdOrCtrl+A",
  "CmdOrCtrl+M",
  "CmdOrCtrl+W",
  "Command+H",
  "Command+Alt+H",
  "CmdOrCtrl+Q",
];

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? items(item.submenu) : []),
  ]);
}

const normalize = (accelerator: string) =>
  accelerator.toLowerCase().split("+").sort().join("+").replace("command", "cmdorctrl");

describe("desktop application menu", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    it(`lists every app shortcut once with its key on ${platform}`, () => {
      const run = vi.fn();
      const all = items(applicationMenuTemplate(platform, server, run));
      const shortcuts = all.filter((item) => item.id?.startsWith("app-shortcut-"));
      expect(shortcuts.map((item) => item.id).sort()).toEqual(
        APP_SHORTCUTS.map((shortcut) => `app-shortcut-${shortcut.id}`).sort(),
      );
      for (const item of shortcuts) {
        (item.click as () => void)();
        expect(run).toHaveBeenLastCalledWith(item.id!.slice("app-shortcut-".length));
        // The page runs the keys; only macOS, which cannot show a key without it, registers them.
        expect(item.registerAccelerator).toBe(platform === "darwin" ? undefined : false);
      }
      const accelerators = all.flatMap((item) => (item.accelerator ? [item.accelerator] : []));
      const keys = [...accelerators, ...ROLE_ACCELERATORS].map(normalize);
      expect(new Set(keys).size).toBe(keys.length);
      expect(all.find((item) => item.id === "local-server-settings")?.accelerator).toBeUndefined();
      expect(all.find((item) => item.id === "app-shortcut-settings")?.accelerator).toBe(
        "CmdOrCtrl+,",
      );
    });
  }

  it("keeps the macOS app menu conventions and Windows and Linux File menu", () => {
    const labels = (template: MenuItemConstructorOptions[]) =>
      template.map((item) => item.label ?? item.role);
    const mac = applicationMenuTemplate("darwin", server, vi.fn());
    expect(labels(mac)).toEqual(["Ardur", "File", "editMenu", "View", "Go", "windowMenu"]);
    const appMenu = mac[0]!.submenu as MenuItemConstructorOptions[];
    expect(appMenu.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      "About Ardur",
      "separator",
      "Settings…",
      "Local Server Settings…",
      "Change Ardur Server…",
      "Stop Local Stack",
      "separator",
      "Hide Ardur",
      "hideOthers",
      "unhide",
      "separator",
      "Quit Ardur",
    ]);
    const other = applicationMenuTemplate("win32", server, vi.fn());
    expect(labels(other)).toEqual(["File", "editMenu", "View", "Go", "windowMenu"]);
    expect(
      (other[0]!.submenu as MenuItemConstructorOptions[]).map(
        (item) => item.label ?? item.role ?? item.type,
      ),
    ).toEqual([
      "New Bot",
      "separator",
      "Settings…",
      "Local Server Settings…",
      "Change Ardur Server…",
      "Stop Local Stack",
      "separator",
      "quit",
    ]);
  });

  it("runs a menu shortcut in the app window unless another Ardur window has focus", () => {
    const send = vi.fn();
    const window = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send },
    };
    type Target = Parameters<typeof runAppShortcut>[0];
    // No Ardur window focused (the window is hidden or minimized): bring it back and run.
    runAppShortcut(window as unknown as Target, "newBot", null);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(APP_SHORTCUT_CHANNEL, "newBot" satisfies AppShortcutId);
    expect(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8")).toContain(
      `ipcRenderer.on("${APP_SHORTCUT_CHANNEL}"`,
    );

    send.mockClear();
    runAppShortcut(window as unknown as Target, "settings", window);
    expect(send).toHaveBeenCalledWith(APP_SHORTCUT_CHANNEL, "settings" satisfies AppShortcutId);

    send.mockClear();
    // The sign-in pop-up, Local Server Settings or setup has focus: leave the app window alone.
    runAppShortcut(window as unknown as Target, "back", { id: "sign-in-popup" });
    runAppShortcut(null, "back", null);
    runAppShortcut({ ...window, isDestroyed: () => true } as unknown as Target, "back", null);
    expect(send).not.toHaveBeenCalled();
  });

  it("turns every shortcut off on the IDE page and back on everywhere else", () => {
    expect(appShortcutsEnabled("https://ardurbot.local/app/ide")).toBe(false);
    expect(appShortcutsEnabled("https://ardurbot.local/app/ide/")).toBe(false);
    expect(appShortcutsEnabled("https://ardurbot.local/app/ide?file=a.ts#L1")).toBe(false);
    expect(appShortcutsEnabled("/app/ide")).toBe(false);
    expect(appShortcutsEnabled("https://ardurbot.local/app/bots")).toBe(true);
    expect(appShortcutsEnabled("https://ardurbot.local/app/ide/extra")).toBe(true);
    expect(appShortcutsEnabled("https://ardurbot.local/app/identity")).toBe(true);
    expect(appShortcutsEnabled("about:blank")).toBe(true);
    expect(appShortcutsEnabled("not a url")).toBe(true);

    const menu = shortcutMenu(true);
    applyAppShortcutMenu(menu, "https://ardurbot.local/app/ide/");
    for (const shortcut of APP_SHORTCUTS) {
      expect(menu.getMenuItemById(`app-shortcut-${shortcut.id}`)?.enabled, shortcut.id).toBe(false);
    }
    applyAppShortcutMenu(menu, "https://ardurbot.local/app/bots");
    for (const shortcut of APP_SHORTCUTS) {
      expect(menu.getMenuItemById(`app-shortcut-${shortcut.id}`)?.enabled, shortcut.id).toBe(true);
    }
  });

  it("follows the main frame and ignores a hidden window", () => {
    const menu = shortcutMenu(true);
    const contents = fakeContents("about:blank");
    let active = true;
    watchAppShortcutMenu(
      contents as unknown as Parameters<typeof watchAppShortcutMenu>[0],
      () => menu,
      () => active,
    );
    contents.emitInPage("https://ardurbot.local/app/ide", false);
    expect(menu.getMenuItemById("app-shortcut-back")?.enabled).toBe(true);
    contents.emitInPage("https://ardurbot.local/app/ide?x=1", true);
    expect(menu.getMenuItemById("app-shortcut-settings")?.enabled).toBe(false);
    contents.emitNavigate("https://ardurbot.local/app/bots");
    expect(menu.getMenuItemById("app-shortcut-back")?.enabled).toBe(true);
    active = false;
    contents.emitNavigate("https://ardurbot.local/app/ide");
    expect(menu.getMenuItemById("app-shortcut-back")?.enabled).toBe(true);
    contents.emitFinish("https://ardurbot.local/app/ide");
    expect(menu.getMenuItemById("app-shortcut-find")?.enabled).toBe(true);
    active = true;
    contents.emitFinish("https://ardurbot.local/app/ide");
    expect(menu.getMenuItemById("app-shortcut-find")?.enabled).toBe(false);

    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).toContain("watchAppShortcutMenu(");
    expect(main).toContain("applyAppShortcutMenu(");
  });
});

function shortcutMenu(enabled: boolean) {
  const entries = new Map(
    APP_SHORTCUTS.map((shortcut) => [`app-shortcut-${shortcut.id}`, { enabled }]),
  );
  return {
    getMenuItemById: (id: string) => entries.get(id) ?? null,
  };
}

function fakeContents(url: string) {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  let current = url;
  return {
    getURL: () => current,
    on(event: string, listener: (...args: never[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    emitNavigate(next: string) {
      current = next;
      for (const listener of listeners.get("did-navigate") ?? [])
        listener({} as never, next as never);
    },
    emitInPage(next: string, isMainFrame: boolean) {
      current = next;
      for (const listener of listeners.get("did-navigate-in-page") ?? [])
        listener({} as never, next as never, isMainFrame as never);
    },
    emitFinish(next: string) {
      current = next;
      for (const listener of listeners.get("did-finish-load") ?? []) listener();
    },
  };
}
