import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({ on: vi.fn(), exit: vi.fn() }));
vi.mock("electron", () => ({ app }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
  app.on.mockClear();
  app.exit.mockClear();
  vi.doUnmock("./main.js");
});

describe("desktop startup boundary", () => {
  it("reports module-load failures before any services or native dialogs", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ARDUR_INSTALL_SMOKE", "1");
    vi.stubEnv("ARDURBOT_USER_DATA_DIR", "isolated-fixture");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.doMock("./main.js", () => {
      expect(stderr).toHaveBeenCalledWith("smoke: main module loading");
      expect(vi.getTimerCount()).toBe(1);
      throw new Error("unsupported packaged import");
    });
    await import("./main-entry.js");
    // The test runner wraps a failed module factory; the startup boundary still catches it.
    expect(stderr).toHaveBeenLastCalledWith(
      expect.stringContaining("smoke: failed at main module loading: Error:"),
    );
    expect(app.exit).toHaveBeenCalledWith(1);
    const { installSmokeProgress } = await import("./startup.js");
    installSmokeProgress?.dispose();
  });

  it("does not install smoke timers or crash listeners on normal startup", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ARDUR_INSTALL_SMOKE", "0");
    const { installSmokeProgress } = await import("./startup.js");
    expect(installSmokeProgress).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(app.on).not.toHaveBeenCalled();
  });

  it("configures the explicit user-data path before taking the singleton lock", async () => {
    const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
    expect(source.indexOf("configureDesktopUserData(app, PERFORMANCE_USER_DATA)")).toBeLessThan(
      source.indexOf("app.requestSingleInstanceLock()"),
    );
    expect(source).toContain("smoke: isolated profile instance lock refused");
  });
});
