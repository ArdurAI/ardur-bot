import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import signMacPreview from "./sign-mac-preview.mjs";

const context = (platform = "darwin", identity: string | null | undefined = "-") => ({
  electronPlatformName: platform,
  appOutDir: path.resolve("fixture", "mac-arm64"),
  packager: {
    platformSpecificBuildOptions: { identity },
    appInfo: { productFilename: "Ardur" },
  },
});

describe("macOS preview bundle seal", () => {
  it.each(["-", null])("signs and verifies without a certificate (%s)", (identity) => {
    const run = vi.fn();
    signMacPreview(context("darwin", identity), run);
    const app = path.join(context().appOutDir, "Ardur.app");
    expect(run.mock.calls).toEqual([
      [
        "codesign",
        ["--force", "--deep", "--sign", "-", "--timestamp=none", app],
        { stdio: "inherit" },
      ],
      ["codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" }],
    ]);
  });

  it.each(["linux", "win32", "mas"])("does nothing on %s", (platform) => {
    const run = vi.fn();
    signMacPreview(context(platform), run);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not overwrite an explicit or automatically selected certificate", () => {
    for (const identity of ["Developer ID Application: Example", undefined]) {
      const run = vi.fn();
      const options = context();
      options.packager.platformSpecificBuildOptions.identity = identity;
      signMacPreview(options, run);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("fails the build on verification error", () => {
    const run = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("invalid seal");
      });
    expect(() => signMacPreview(context(), run)).toThrow("invalid seal");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails before verification when signing fails", () => {
    const run = vi.fn(() => {
      throw new Error("signing failed");
    });
    expect(() => signMacPreview(context(), run)).toThrow("signing failed");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
