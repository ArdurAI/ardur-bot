import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isAllowedDesktopPath } from "./desktop-sandbox-paths.js";
import { resolveWin32FinalPath } from "./desktop-sandbox-win32-path.js";

describe("Windows canonical workspace containment", () => {
  it("resolves a short-name root once through the same primitive as opened handles", async () => {
    const configured = "C:\\PROGRA~1\\Workspace";
    const finalRoot = "\\\\?\\C:\\Program Files\\Workspace";
    const close = vi.fn(async () => {});
    const primitives = {
      openPath: vi.fn(async () => ({ fd: 7, close })),
      pathFromFd: vi.fn((fd: number) =>
        fd === 7 ? finalRoot : "\\\\?\\c:\\Program Files\\Workspace\\notes\\file.txt",
      ),
    };
    const root = await resolveWin32FinalPath(configured, primitives);
    for (const fd of [8, 9])
      expect(isAllowedDesktopPath(primitives.pathFromFd(fd), [root], path.win32)).toBe(true);
    expect(primitives.openPath).toHaveBeenCalledExactlyOnceWith(configured);
    expect(primitives.pathFromFd).toHaveBeenCalledWith(7);
    expect(close).toHaveBeenCalledOnce();
    // Text normalization alone cannot equate an 8.3 alias with its long name.
    expect(isAllowedDesktopPath(primitives.pathFromFd(8), [configured], path.win32)).toBe(false);
  });

  it("closes the root handle and fails closed when its final name cannot be read", async () => {
    const close = vi.fn(async () => {});
    await expect(
      resolveWin32FinalPath("C:\\Workspace", {
        openPath: async () => ({ fd: 7, close }),
        pathFromFd: () => {
          throw new Error("Final name unavailable");
        },
      }),
    ).rejects.toThrow("Final name unavailable");
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ["drive case", "C:\\Workspace", "c:\\Workspace\\file.txt"],
    ["directory case", "C:\\Workspace", "C:\\WORKSPACE\\file.txt"],
    ["extended child", "C:\\Workspace", "\\\\?\\C:\\Workspace\\file.txt"],
    ["extended root", "\\\\?\\C:\\Workspace", "C:\\Workspace\\file.txt"],
    ["trailing root separator", "C:\\Workspace\\", "C:\\Workspace\\file.txt"],
    ["trailing child separator", "C:\\Workspace", "C:\\Workspace\\notes\\"],
    ["root itself", "\\\\?\\C:\\Workspace\\", "c:\\Workspace"],
    ["drive root", "C:\\", "\\\\?\\c:\\Workspace\\file.txt"],
    [
      "UNC prefix",
      "\\\\server\\share\\Workspace",
      "\\\\?\\UNC\\server\\share\\Workspace\\file.txt",
    ],
    [
      "UNC case",
      "\\\\?\\UNC\\SERVER\\SHARE\\Workspace\\",
      "\\\\server\\share\\Workspace\\file.txt",
    ],
  ])("accepts equivalent final forms: %s", (_name, root, target) => {
    expect(isAllowedDesktopPath(target, [root], path.win32)).toBe(true);
  });

  it.each([
    "C:\\Workspace-other\\file.txt",
    "C:\\Workspace\\..\\outside.txt",
    "C:\\Workspace\\notes\\..\\file.txt",
    "C:\\outside\\file.txt",
    "D:\\Workspace\\file.txt",
    "\\\\?\\D:\\Workspace\\file.txt",
    "\\\\server\\share\\Workspace\\file.txt",
    "\\\\.\\C:\\Workspace\\file.txt",
    "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\Workspace\\file.txt",
    "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\Workspace\\file.txt",
    "\\??\\C:\\Workspace\\file.txt",
    "C:Workspace\\file.txt",
    "\\Workspace\\file.txt",
    "C:\\Workspace\\file.txt:stream",
    "C:\\Workspace\\NUL.txt",
    "C:\\Workspace\\file.txt\0",
  ])("refuses escaping or device paths: %s", (target) => {
    expect(isAllowedDesktopPath(target, ["C:\\Workspace"], path.win32)).toBe(false);
  });

  it.each([
    "\\\\other\\share\\Workspace\\file.txt",
    "\\\\server\\other\\Workspace\\file.txt",
    "\\\\server\\share\\Workspace-other\\file.txt",
    "\\\\?\\UNC\\server\\share\\Workspace\\..\\outside.txt",
  ])("refuses a different UNC boundary: %s", (target) => {
    expect(isAllowedDesktopPath(target, ["\\\\server\\share\\Workspace"], path.win32)).toBe(false);
  });

  it("refuses a device namespace even when it is also supplied as the root", () => {
    const root = "\\\\.\\C:\\Workspace";
    expect(isAllowedDesktopPath(`${root}\\file.txt`, [root], path.win32)).toBe(false);
  });
});
