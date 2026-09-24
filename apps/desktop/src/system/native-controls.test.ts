import { describe, expect, it, vi } from "vitest";
import {
  permissionStatus,
  permissions,
  permissionUrl,
  RoutinePower,
  setStartup,
  startupEnabled,
} from "./native-controls.js";

function loginApp() {
  let enabled = false;
  return {
    getLoginItemSettings: vi.fn(() => ({
      openAtLogin: enabled,
      executableWillLaunchAtLogin: enabled,
    })),
    setLoginItemSettings: vi.fn((value: { openAtLogin?: boolean }) => {
      enabled = value.openAtLogin ?? false;
    }),
  };
}

describe("startup", () => {
  it.each(["darwin", "win32"])("sets and reads back %s login state", (platform) => {
    const app = loginApp();
    setStartup(platform, app, true);
    expect(startupEnabled(platform, app)).toBe(true);
    setStartup(platform, app, false);
    expect(startupEnabled(platform, app)).toBe(false);
    expect(app.setLoginItemSettings).toHaveBeenNthCalledWith(1, {
      openAtLogin: true,
      ...(platform === "win32" ? { enabled: true } : {}),
    });
  });
  it("never calls unsupported login APIs on Linux", () => {
    const app = loginApp();
    expect(startupEnabled("linux", app)).toBe(false);
    expect(() => setStartup("linux", app, true)).toThrow("unavailable");
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });
  it("refuses a setting that the operating system did not accept", () => {
    const app = loginApp();
    app.setLoginItemSettings.mockImplementation(() => undefined);
    expect(() => setStartup("darwin", app, true)).toThrow("Allow startup");
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
  });
});

describe("permission status", () => {
  it.each(["granted", "denied", "restricted", "not-determined", "unknown"])(
    "maps %s without inventing permission",
    (status) => {
      expect(permissionStatus(status)).toBe(status);
    },
  );
  it("handles unknown OS values conservatively", () =>
    expect(permissionStatus("future-value")).toBe("unknown"));
  it("probes macOS without opening an accessibility prompt", () => {
    const native = {
      isTrustedAccessibilityClient: vi.fn(() => false),
      getMediaAccessStatus: vi.fn(() => "restricted"),
    };
    expect(permissions("darwin", native)).toEqual({
      accessibility: "denied",
      screen: "restricted",
    });
    expect(native.isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
    expect(native.getMediaAccessStatus).toHaveBeenCalledWith("screen");
  });
  it.each(["win32", "linux"])("does not probe permissions on %s", (platform) => {
    const native = { isTrustedAccessibilityClient: vi.fn(), getMediaAccessStatus: vi.fn() };
    expect(permissions(platform, native)).toBeNull();
    expect(native.getMediaAccessStatus).not.toHaveBeenCalled();
    expect(native.isTrustedAccessibilityClient).not.toHaveBeenCalled();
  });
  it("only opens the two fixed permission panes", () => {
    expect(permissionUrl("screen")).toContain("Privacy_ScreenCapture");
    expect(permissionUrl("accessibility")).toContain("Privacy_Accessibility");
    expect(() => permissionUrl("https://example.invalid")).toThrow();
  });
});

describe("routine power", () => {
  it("starts once while both conditions hold and stops for either false condition", () => {
    const blocker = { start: vi.fn(() => 0), stop: vi.fn() };
    const power = new RoutinePower(blocker);
    power.update(false, 2);
    power.update(true, 0);
    expect(blocker.start).not.toHaveBeenCalled();
    power.update(true, 2);
    power.update(true, 3);
    expect(blocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
    expect(power.activeRoutines).toBe(3);
    power.update(true, 0);
    expect(blocker.stop).toHaveBeenCalledWith(0);
    expect(power.activeRoutines).toBe(0);
    power.update(true, 1);
    power.update(false, 1);
    expect(blocker.stop).toHaveBeenCalledTimes(2);
    power.stop();
    expect(blocker.stop).toHaveBeenCalledTimes(2);
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
    "rejects invalid routine count %s",
    (count) => {
      const blocker = { start: vi.fn(), stop: vi.fn() };
      new RoutinePower(blocker).update(true, count);
      expect(blocker.start).not.toHaveBeenCalled();
    },
  );
});
