import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopTray, staysRunning, updateHostTray } from "./tray.js";

const fake = vi.hoisted(() => ({
  create: vi.fn(),
  template: vi.fn(),
  menu: vi.fn((items) => items),
  tooltip: vi.fn(),
  contextMenu: vi.fn(),
  on: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { dock: { setMenu: vi.fn() } },
  nativeImage: { createFromPath: () => ({ resize: () => ({ setTemplateImage: fake.template }) }) },
  Menu: { buildFromTemplate: fake.menu },
  Tray: class {
    constructor(icon: string) {
      fake.create(icon);
    }
    setToolTip = fake.tooltip;
    setContextMenu = fake.contextMenu;
    on = fake.on;
  },
}));
beforeEach(() => vi.clearAllMocks());
describe("platform tray lifecycle", () => {
  it.each(["win32", "linux", "darwin"] as const)(
    "stops with the window on %s when background work is off",
    (platform) => {
      expect(staysRunning(platform, true, false)).toBe(false);
      expect(staysRunning(platform, false, false)).toBe(false);
    },
  );
  it.each(["win32", "linux"] as const)(
    "keeps %s reachable after closing its window",
    (platform) => {
      const show = vi.fn();
      const quit = vi.fn();
      expect(createDesktopTray(platform, "icon.png", show, quit)).not.toBeNull();
      expect(fake.create).toHaveBeenCalledWith("icon.png");
      const menu = fake.menu.mock.calls[0]![0];
      menu[0].click();
      menu[2].click();
      expect(show).toHaveBeenCalledOnce();
      expect(quit).toHaveBeenCalledOnce();
      expect(fake.on).toHaveBeenCalledWith("click", show);
      expect(staysRunning(platform, true)).toBe(true);
      expect(staysRunning(platform, false)).toBe(false);
    },
  );
  it("uses the macOS dock without creating another tray icon", () => {
    expect(createDesktopTray("darwin", "icon.png", vi.fn(), vi.fn())).toBeNull();
    expect(fake.create).not.toHaveBeenCalled();
    expect(staysRunning("darwin", false)).toBe(true);
  });
  it("allows quitting when tray creation fails", () => {
    fake.create.mockImplementationOnce(() => {
      throw new Error("No tray host");
    });
    expect(createDesktopTray("linux", "icon.png", vi.fn(), vi.fn())).toBeNull();
    expect(staysRunning("linux", false)).toBe(false);
  });
});

it("adds an opt-in macOS template tray with current host status, Open and Quit", () => {
  updateHostTray(null, true);
  const show = vi.fn(),
    quit = vi.fn();
  const tray = createDesktopTray("darwin", "icon.png", show, quit, true);
  expect(tray).not.toBeNull();
  expect(fake.template).toHaveBeenCalledWith(true);
  const menu = fake.menu.mock.lastCall![0];
  expect(menu[1]).toMatchObject({ label: "Host service: Connected", enabled: false });
  menu[0].click();
  menu[3].click();
  expect(show).toHaveBeenCalledOnce();
  expect(quit).toHaveBeenCalledOnce();
  updateHostTray(tray, false);
  expect(fake.menu.mock.lastCall![0][1].label).toBe("Host service: Not running");
});
