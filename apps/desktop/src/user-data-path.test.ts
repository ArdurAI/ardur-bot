import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureDesktopUserData } from "./user-data-path.js";

describe("desktop user data continuity", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("uses the existing folder after the display name changes", () => {
    const appData = mkdtempSync(path.join(os.tmpdir(), "ardur-data-path-"));
    roots.push(appData);
    const app = {
      getPath: vi.fn(() => appData),
      setName: vi.fn(),
      setPath: vi.fn(),
    };
    configureDesktopUserData(app);
    const userData = path.join(appData, "Ardur Bot");
    expect(app.getPath).toHaveBeenCalledWith("appData");
    expect(app.setPath).toHaveBeenNthCalledWith(1, "userData", userData);
    expect(app.setName).toHaveBeenCalledWith("Ardur Bot");
    expect(app.setName.mock.invocationCallOrder[0]).toBeLessThan(
      app.setPath.mock.invocationCallOrder[0] ?? 0,
    );
    expect(app.setPath).toHaveBeenNthCalledWith(2, "sessionData", userData);
    expect(existsSync(userData)).toBe(true);
  });

  it("opens Chromium storage already present in a normal pre-rename install", () => {
    const appData = mkdtempSync(path.join(os.tmpdir(), "ardur-upgrade-data-"));
    roots.push(appData);
    const userData = path.join(appData, "Ardur Bot");
    const localStorage = path.join(userData, "Local Storage", "leveldb");
    mkdirSync(localStorage, { recursive: true });
    writeFileSync(path.join(localStorage, "CURRENT"), "MANIFEST-000001");
    writeFileSync(path.join(userData, "Cookies"), "existing-cookie-store");
    const app = { getPath: vi.fn(() => appData), setName: vi.fn(), setPath: vi.fn() };

    configureDesktopUserData(app);

    expect(app.setPath).toHaveBeenNthCalledWith(1, "userData", userData);
    expect(app.setPath).toHaveBeenNthCalledWith(2, "sessionData", userData);
    expect(existsSync(path.join(localStorage, "CURRENT"))).toBe(true);
    expect(existsSync(path.join(userData, "Cookies"))).toBe(true);
  });

  it("keeps explicit data paths for isolated launches", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ardur-isolated-data-"));
    roots.push(root);
    const isolated = path.join(root, "isolated");
    const app = { getPath: vi.fn(), setName: vi.fn(), setPath: vi.fn() };
    configureDesktopUserData(app, isolated);
    expect(app.getPath).not.toHaveBeenCalled();
    expect(app.setName).toHaveBeenCalledWith("Ardur Bot");
    expect(app.setPath).toHaveBeenNthCalledWith(1, "userData", isolated);
    expect(app.setPath).toHaveBeenNthCalledWith(2, "sessionData", path.join(isolated, "session"));
  });
});
