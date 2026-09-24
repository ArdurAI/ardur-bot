import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Win32NativeApi } from "@ardurbot/host-runtime/desktop-sandbox-win32-path";

interface NativeAddon extends Omit<Win32NativeApi, "sizeof"> {
  version: string;
  type(spec: unknown): { size: number };
}

/** Only the packaged binary beside this bundle can enable Windows writes. */
export function loadWin32NativeAddon(bundleFile: string): Win32NativeApi | undefined {
  if (process.platform !== "win32" || !path.isAbsolute(bundleFile)) return undefined;
  if (!["x64", "arm64", "ia32"].includes(process.arch)) return undefined;
  const nativeRoot = path.join(path.dirname(bundleFile), "native");
  const target = path.join(nativeRoot, `win_${process.arch}`);
  const addon = path.join(target, "koffi.node");
  try {
    // Do not follow a substituted native directory or addon outside the bundle.
    if (!lstatSync(nativeRoot).isDirectory() || !lstatSync(target).isDirectory()) return undefined;
    if (!lstatSync(addon).isFile()) return undefined;
    const native = createRequire(bundleFile)(addon) as NativeAddon;
    if (
      native.version !== "3.2.1" ||
      typeof native.load !== "function" ||
      typeof native.struct !== "function" ||
      typeof native.type !== "function"
    )
      return undefined;
    // Koffi 3's JS wrapper adds sizeof; the raw addon exposes type(spec).size.
    return {
      load: (name) => native.load(name),
      struct: (name, members) => native.struct(name, members),
      sizeof: (spec) => native.type(spec).size,
    };
  } catch {
    // Missing, incompatible or unloadable addons retain the existing refusal.
    return undefined;
  }
}
