import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWin32NativeAddon } from "./native-addon.js";

const mocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  createRequire: vi.fn(),
  require: vi.fn(),
}));
vi.mock("node:fs", () => ({ lstatSync: mocks.lstat }));
vi.mock("node:module", () => ({ createRequire: mocks.createRequire }));

const bundle = path.resolve("/fixture/relocated/host-service.cjs");
const native = {
  version: "3.2.1",
  load: vi.fn(() => ({ func: vi.fn() })),
  struct: vi.fn(() => ({ name: "OBJECT_ATTRIBUTES" })),
  type: vi.fn(() => ({ size: 48 })),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(process, "arch", "get").mockReturnValue("x64");
  mocks.lstat.mockImplementation((file: string) => ({
    isDirectory: () => !file.endsWith(".node"),
    isFile: () => file.endsWith(".node"),
  }));
  mocks.createRequire.mockReturnValue(mocks.require);
  mocks.require.mockReturnValue(native);
});
afterEach(() => vi.restoreAllMocks());

describe("packaged Windows addon", () => {
  it("accepts the koffi version pinned by the existing adapter dependency", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../../packages/adapters/package.json", import.meta.url), "utf8"),
    );
    mocks.require.mockReturnValue({ ...native, version: manifest.dependencies.koffi });
    expect(loadWin32NativeAddon(bundle)).toBeDefined();
  });

  it.each(["x64", "arm64", "ia32"] as const)(
    "loads only the %s binary relative to the bundle, independent of the executable and cwd",
    (arch) => {
      vi.spyOn(process, "arch", "get").mockReturnValue(arch);
      vi.spyOn(process, "cwd").mockReturnValue(path.resolve("/unrelated/workspace"));
      const api = loadWin32NativeAddon(bundle);
      expect(api).toBeDefined();
      expect(mocks.createRequire).toHaveBeenCalledExactlyOnceWith(bundle);
      expect(mocks.require).toHaveBeenCalledExactlyOnceWith(
        path.join(path.dirname(bundle), "native", `win_${arch}`, "koffi.node"),
      );
      const type = api!.struct("OBJECT_ATTRIBUTES", { Length: "uint32_t" });
      expect(api!.sizeof(type)).toBe(48);
      expect(native.type).toHaveBeenCalledWith(type);
      api!.load("ntdll.dll");
      expect(native.load).toHaveBeenCalledWith("ntdll.dll");
    },
  );

  it.each(["darwin", "linux"] as const)("never probes or loads an addon on %s", (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    expect(loadWin32NativeAddon(bundle)).toBeUndefined();
    expect(mocks.lstat).not.toHaveBeenCalled();
    expect(mocks.createRequire).not.toHaveBeenCalled();
  });

  it("refuses a relative bundle location and an unsupported architecture", () => {
    expect(loadWin32NativeAddon("host-service.cjs")).toBeUndefined();
    vi.spyOn(process, "arch", "get").mockReturnValue("arm");
    expect(loadWin32NativeAddon(bundle)).toBeUndefined();
    expect(mocks.createRequire).not.toHaveBeenCalled();
  });

  it("does not search node_modules, cwd or the executable directory when the addon is missing", () => {
    mocks.lstat.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(loadWin32NativeAddon(bundle)).toBeUndefined();
    expect(mocks.createRequire).not.toHaveBeenCalled();
    expect(mocks.require).not.toHaveBeenCalled();
  });

  it.each(["native", "target", "addon"])("refuses a symlink replacing the %s", (part) => {
    const paths = [
      path.join(path.dirname(bundle), "native"),
      path.join(path.dirname(bundle), "native/win_x64"),
      path.join(path.dirname(bundle), "native/win_x64/koffi.node"),
    ];
    const link = paths[["native", "target", "addon"].indexOf(part)];
    mocks.lstat.mockImplementation((file: string) => ({
      isDirectory: () => file !== link && !file.endsWith(".node"),
      isFile: () => file !== link && file.endsWith(".node"),
    }));
    expect(loadWin32NativeAddon(bundle)).toBeUndefined();
    expect(mocks.require).not.toHaveBeenCalled();
  });

  it("refuses an incompatible binary without a fallback", () => {
    mocks.require.mockImplementation(() => {
      throw new Error("Invalid native module");
    });
    expect(loadWin32NativeAddon(bundle)).toBeUndefined();
    expect(mocks.require).toHaveBeenCalledTimes(1);
  });

  it.each([{ ...native, version: "0.0.0" }, { version: "3.2.1" }])(
    "refuses a version or API mismatch",
    (addon) => {
      mocks.require.mockReturnValue(addon);
      expect(loadWin32NativeAddon(bundle)).toBeUndefined();
    },
  );
});
