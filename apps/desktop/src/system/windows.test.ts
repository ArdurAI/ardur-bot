import type { Session } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  windows: [] as Array<{
    events: Map<string, (...args: unknown[]) => void>;
    contentEvents: Map<string, (...args: unknown[]) => void>;
    show: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    permission: ReturnType<typeof vi.fn>;
    check: ReturnType<typeof vi.fn>;
  }>,
  external: vi.fn(),
}));
vi.mock("electron", () => ({
  shell: { openExternal: fake.external },
  BrowserWindow: class {
    events = new Map();
    contentEvents = new Map();
    show = vi.fn();
    close = vi.fn();
    focus = vi.fn();
    destroy = vi.fn();
    isDestroyed = () => false;
    loadURL = vi.fn(async () => undefined);
    open = vi.fn();
    permission = vi.fn();
    check = vi.fn();
    webContents = {
      setWindowOpenHandler: this.open,
      session: {
        setPermissionCheckHandler: this.check,
        setPermissionRequestHandler: this.permission,
      },
      on: (name: string, fn: unknown) => this.contentEvents.set(name, fn),
    };
    once = (name: string, fn: unknown) => this.events.set(name, fn);
    constructor(options: Record<string, unknown>) {
      fake.options.push(options);
      fake.windows.push(this);
    }
  },
}));

import { createQuickAccessWindow, openLinkViewer } from "./windows.js";

beforeEach(() => {
  fake.options.length = 0;
  fake.windows.length = 0;
  vi.clearAllMocks();
});

describe("system windows", () => {
  it("creates an always-on-top composer on the authenticated home and closes on Escape", () => {
    const session = {} as Session;
    createQuickAccessWindow({
      rendererUrl: "https://home.example.invalid/?composer=1",
      targetUrl: "https://home.example.invalid",
      session,
    });
    expect(fake.options[0]).toMatchObject({
      width: 560,
      alwaysOnTop: true,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, session },
    });
    expect(fake.options[0]!.webPreferences).not.toHaveProperty("preload");
    const window = fake.windows[0]!;
    window.events.get("ready-to-show")!();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    const event = { preventDefault: vi.fn() };
    window.contentEvents.get("before-input-event")!(event, { type: "keyDown", key: "Escape" });
    expect(window.close).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.open.mock.calls[0]![0]({ url: "https://example.invalid" })).toEqual({
      action: "deny",
    });
  });
  it("refuses a composer URL outside the authenticated home", () => {
    expect(() =>
      createQuickAccessWindow({
        rendererUrl: "https://outside.example.invalid",
        targetUrl: "https://home.example.invalid",
        session: {} as Session,
      }),
    ).toThrow();
    expect(fake.options).toHaveLength(0);
  });
  it("isolates link viewer storage, privileges, permissions and protocols", () => {
    openLinkViewer("https://example.invalid/article");
    const preferences = fake.options[0]!.webPreferences as Record<string, unknown>;
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    });
    expect(preferences).not.toHaveProperty("preload");
    expect(preferences.partition).toMatch(/^system-viewer-/);
    const window = fake.windows[0]!;
    expect(window.check.mock.calls[0]![0]()).toBe(false);
    const answer = vi.fn();
    window.permission.mock.calls[0]![0]({}, "media", answer);
    expect(answer).toHaveBeenCalledWith(false);
    const event = { preventDefault: vi.fn() };
    window.contentEvents.get("will-redirect")!(event, "file:///fixture/private");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.open.mock.calls[0]![0]({ url: "javascript:alert(1)" })).toEqual({
      action: "deny",
    });
    expect(fake.external).not.toHaveBeenCalled();
  });
  it.each(["file:///fixture/private", "javascript:alert(1)", "data:text/html,unsafe"])(
    "refuses link scheme %s",
    (url) => {
      expect(() => openLinkViewer(url)).toThrow("cannot be opened");
      expect(fake.options).toHaveLength(0);
    },
  );
});
