import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopTray, staysRunning } from "./tray.js";

const fake = vi.hoisted(() => ({
  create: vi.fn(),
  menu: vi.fn((items) => items),
  tooltip: vi.fn(),
  contextMenu: vi.fn(),
  on: vi.fn(),
}));
vi.mock("electron", () => ({
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
