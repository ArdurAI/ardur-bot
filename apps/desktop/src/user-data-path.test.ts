import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
      setPath: vi.fn(),
    };
    configureDesktopUserData(app);
    const userData = path.join(appData, "Ardur Bot");
    expect(app.getPath).toHaveBeenCalledWith("appData");
    expect(app.setPath).toHaveBeenNthCalledWith(1, "userData", userData);
    expect(app.setPath).toHaveBeenNthCalledWith(
      2,
      "sessionData",
      path.join(userData, "session"),
    );
    expect(existsSync(path.join(userData, "session"))).toBe(true);
  });

  it("keeps explicit data paths for isolated launches", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ardur-isolated-data-"));
    roots.push(root);
    const isolated = path.join(root, "isolated");
    const app = { getPath: vi.fn(), setPath: vi.fn() };
    configureDesktopUserData(app, isolated);
    expect(app.getPath).not.toHaveBeenCalled();
    expect(app.setPath).toHaveBeenNthCalledWith(1, "userData", isolated);
    expect(app.setPath).toHaveBeenNthCalledWith(2, "sessionData", path.join(isolated, "session"));
  });
});
