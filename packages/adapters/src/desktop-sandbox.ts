import { installWin32Bindings } from "@ardurbot/host-runtime/desktop-sandbox-win32-path";
import * as bindings from "./desktop-sandbox-win32-path.js";

installWin32Bindings(bindings);

export { DesktopSandboxProvider } from "@ardurbot/host-runtime/desktop-sandbox";
