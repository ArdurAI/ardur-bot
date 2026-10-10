import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  enabled: false,
  setEnabled: vi.fn(),
  listeners: new Map<string, Array<(...args: unknown[]) => void>>(),
}));
vi.mock("electron", () => ({
  app: {
    get accessibilitySupportEnabled() {
      return fake.enabled;
    },
    set accessibilitySupportEnabled(value: boolean) {
      fake.enabled = value;
      fake.setEnabled(value);
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = fake.listeners.get(event) ?? [];
      list.push(listener);
      fake.listeners.set(event, list);
    },
  },
}));

import {
  ACCESSIBILITY_FORCED_LOG,
  ACCESSIBILITY_RESTORED_LOG,
  applyDesktopAccessibilitySwitches,
  desktopAccessibilityWebPreferences,
  enableDesktopAccessibility,
} from "./accessibility.js";

function emit(event: string, ...args: unknown[]) {
  for (const listener of fake.listeners.get(event) ?? []) listener(...args);
}

function fakeContents() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

beforeEach(() => {
  fake.enabled = false;
  fake.setEnabled.mockClear();
  fake.listeners.clear();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("desktop accessibility", () => {
  it("forces accessibility on and reports it once when explicitly enabled", () => {
    vi.stubEnv("ARDUR_DESKTOP_ACCESSIBILITY", "1");
    enableDesktopAccessibility();
    expect(fake.enabled).toBe(true);
    expect(fake.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(console.info).toHaveBeenCalledExactlyOnceWith(ACCESSIBILITY_FORCED_LOG);
  });

  it.each([undefined, "", "0", "true", "01", "1 ", " 1", "1\n"])(
    "preserves existing accessibility state for %j",
    (value) => {
      vi.stubEnv("ARDUR_DESKTOP_ACCESSIBILITY", value);
      const commandLine = { appendSwitch: vi.fn() };
      for (const enabled of [false, true]) {
        fake.enabled = enabled;
        enableDesktopAccessibility();
        applyDesktopAccessibilitySwitches(commandLine);
        expect(desktopAccessibilityWebPreferences()).toEqual({});
        expect(fake.enabled).toBe(enabled);
        expect(fake.setEnabled).not.toHaveBeenCalled();
        expect(console.info).not.toHaveBeenCalled();
        expect(commandLine.appendSwitch).not.toHaveBeenCalled();
        expect(fake.listeners.size).toBe(0);
      }
    },
  );

  it("enables accessibility for development launches across platforms", () => {
    const desktop = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(desktop.scripts.dev).toBe(
      "pnpm build && cross-env ARDUR_DESKTOP_ACCESSIBILITY=1 electron .",
    );
    const turbo = JSON.parse(readFileSync(new URL("../../../turbo.json", import.meta.url), "utf8"));
    expect(turbo.tasks.dev.passThroughEnv).toContain("ARDUR_DESKTOP_ACCESSIBILITY");
  });

  it("applies the verified switches and window preference only while the flag is on", () => {
    const commandLine = { appendSwitch: vi.fn() };
    applyDesktopAccessibilitySwitches(commandLine);
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
    expect(desktopAccessibilityWebPreferences()).toEqual({});

    vi.stubEnv("ARDUR_DESKTOP_ACCESSIBILITY", "1");
    applyDesktopAccessibilitySwitches(commandLine);
    // Name the switches literally so dropping one from the constant fails this test.
    expect(commandLine.appendSwitch.mock.calls).toEqual([
      ["disable-backgrounding-occluded-windows"],
      ["disable-renderer-backgrounding"],
      ["force-renderer-accessibility"],
    ]);
    expect(desktopAccessibilityWebPreferences()).toEqual({ backgroundThrottling: false });
  });

  it("appends the switches before Electron is ready and passes the preference into windows", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const switches = main.indexOf("applyDesktopAccessibilitySwitches(app.commandLine)");
    const ready = main.indexOf("app.whenReady()");
    expect(switches).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(switches);
    expect(main).not.toContain("desktopAccessibilityWebPreferences");
    const windows = readFileSync(new URL("./system/windows.ts", import.meta.url), "utf8");
    expect(windows.match(/\.\.\.desktopAccessibilityWebPreferences\(\)/g)).toHaveLength(2);
    const accessibility = readFileSync(new URL("./accessibility.ts", import.meta.url), "utf8");
    expect(accessibility).toContain("browserWindow.webContents.backgroundThrottling = false");
  });

  it("turns support back on after it is cleared, and after a reload or a new renderer", () => {
    vi.stubEnv("ARDUR_DESKTOP_ACCESSIBILITY", "1");
    enableDesktopAccessibility();
    fake.setEnabled.mockClear();
    vi.mocked(console.info).mockClear();

    fake.enabled = false;
    emit("accessibility-support-changed", {}, false);
    expect(fake.enabled).toBe(true);
    expect(fake.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(console.info).toHaveBeenCalledExactlyOnceWith(ACCESSIBILITY_RESTORED_LOG);

    fake.setEnabled.mockClear();
    vi.mocked(console.info).mockClear();
    emit("accessibility-support-changed", {}, true);
    expect(fake.setEnabled).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();

    const contents = fakeContents();
    emit("web-contents-created", {}, contents);
    const navigation = {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://home.example.invalid/app",
    };
    contents.emit("did-start-navigation", navigation);
    contents.emit("did-start-navigation", { ...navigation, isSameDocument: true });
    contents.emit("did-start-navigation", { ...navigation, isMainFrame: false });
    contents.emit("did-start-navigation", {
      ...navigation,
      url: "https://home.example.invalid/other",
    });
    expect(fake.setEnabled).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();

    contents.emit("did-start-navigation", {
      ...navigation,
      url: "https://home.example.invalid/other",
    });
    expect(fake.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(console.info).toHaveBeenCalledExactlyOnceWith(ACCESSIBILITY_RESTORED_LOG);

    fake.setEnabled.mockClear();
    vi.mocked(console.info).mockClear();
    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    expect(fake.enabled).toBe(true);
    expect(fake.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(console.info).toHaveBeenCalledExactlyOnceWith(ACCESSIBILITY_RESTORED_LOG);
  });

  it("recognizes a reload of a route reached by an in-app navigation", () => {
    vi.stubEnv("ARDUR_DESKTOP_ACCESSIBILITY", "1");
    enableDesktopAccessibility();
    const contents = fakeContents();
    emit("web-contents-created", {}, contents);
    fake.setEnabled.mockClear();
    const page = (url: string, isSameDocument = false) => ({
      isMainFrame: true,
      isSameDocument,
      url: `https://home.example.invalid${url}`,
    });
    contents.emit("did-start-navigation", page("/app"));
    contents.emit("did-start-navigation", page("/bots", true));
    expect(fake.setEnabled).not.toHaveBeenCalled();
    contents.emit("did-start-navigation", page("/bots"));
    expect(fake.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("keeps background throttling off for a new window only while the flag is on", () => {
    const created = { webContents: { backgroundThrottling: true } };
    enableDesktopAccessibility();
    emit("browser-window-created", {}, created);
    expect(created.webContents.backgroundThrottling).toBe(true);

    vi.stubEnv("ARDUR_DESKTOP_ACCESSIBILITY", "1");
    enableDesktopAccessibility();
    fake.enabled = false;
    fake.setEnabled.mockClear();
    emit("browser-window-created", {}, created);
    expect(created.webContents.backgroundThrottling).toBe(false);
    expect(fake.enabled).toBe(true);
    expect(console.info).toHaveBeenCalledWith(ACCESSIBILITY_RESTORED_LOG);
  });
});
