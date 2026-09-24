import { createRequire } from "node:module";
import { installWin32NativeApi } from "@ardurbot/host-runtime/desktop-sandbox-win32-path";

// Source development keeps the existing dependency, loaded only when Windows needs it.
const requireNative = createRequire(import.meta.url);
installWin32NativeApi(() => requireNative("koffi"));

export * from "@ardurbot/host-runtime/desktop-sandbox-win32-path";
