import { execFileSync } from "node:child_process";
import path from "node:path";

/** afterSign runs after asar, extraResources, and Electron fuses are final. */
export default function signMacPreview(context, run = execFileSync) {
  if (context.electronPlatformName !== "darwin") return;
  const identity = context.packager.platformSpecificBuildOptions.identity;
  // Never replace a certificate signature (including automatic identity discovery).
  if (identity !== "-" && identity !== null) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  run("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", app], {
    stdio: "inherit",
  });
  run("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
}
